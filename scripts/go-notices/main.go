// NFR-SEC-010 / AC-MNT-004: preserve exact module attribution, without license approval.
package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"debug/buildinfo"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime/debug"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	maxArchive     = 128 << 20
	maxExpanded    = 500 << 20
	maxFiles       = 10000
	maxNotice      = 128 << 10 // Below the pinned Syft content-capture limit.
	maxNotices     = 512
	maxNoticeTotal = 4 << 20
	imageRoot      = "/usr/share/caddy/modules"
)

type notice struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}
type module struct {
	Path    string   `json:"path"`
	Version string   `json:"version"`
	Sum     string   `json:"sum"`
	Notices []notice `json:"notices"`
}
type binary struct {
	Path          string            `json:"path"`
	SHA256        string            `json:"sha256"`
	GoVersion     string            `json:"goVersion"`
	MainModule    string            `json:"mainModule"`
	BuildSettings map[string]string `json:"buildSettings"`
}
type inventory struct {
	SchemaVersion  int      `json:"schemaVersion"`
	ReviewRequired bool     `json:"reviewRequired"`
	Binary         binary   `json:"binary"`
	Modules        []module `json:"modules"`
}
type shippedNotice struct {
	notice
	ShippedPath string `json:"shippedPath"`
}
type moduleEvidence struct {
	Path         string          `json:"path"`
	Version      string          `json:"version"`
	Sum          string          `json:"sum"`
	ZipSHA256    string          `json:"zipSha256"`
	NoticeStatus string          `json:"noticeStatus"`
	Notices      []shippedNotice `json:"notices"`
}
type manifest struct {
	SchemaVersion   int              `json:"schemaVersion"`
	ReviewRequired  bool             `json:"reviewRequired"`
	Coverage        string           `json:"coverage"`
	SourceMethod    string           `json:"sourceMethod"`
	InventorySHA256 string           `json:"inventorySha256"`
	Binary          binary           `json:"binary"`
	Modules         []moduleEvidence `json:"modules"`
}

var shaPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var modulePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._~/-]*$`)
var versionPattern = regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?(?:\+incompatible)?$`)
var attributionName = regexp.MustCompile(`(?i)^(?:licen[sc]es?|notices?|copyrights?|copying|authors|patents|third[-_ ]party(?:[-_ ]notices?)?)(?:$|[._ -])`)
var sourceExtension = regexp.MustCompile(`(?i)\.(?:go|js|ts|tsx|jsx|py|c|h|cc|cpp|rs|java|sh|bat|exe|dll|so|png|jpg|svg|gif|pdf|json)$`)

func digest(b []byte) string { sum := sha256.Sum256(b); return hex.EncodeToString(sum[:]) }
func validSum(s string) bool {
	if !strings.HasPrefix(s, "h1:") {
		return false
	}
	b, err := base64.StdEncoding.Strict().DecodeString(strings.TrimPrefix(s, "h1:"))
	return err == nil && len(b) == sha256.Size && "h1:"+base64.StdEncoding.EncodeToString(b) == s
}
func safeRelative(p string) bool {
	if p == "" || !utf8.ValidString(p) || path.IsAbs(p) || path.Clean(p) != p || strings.ContainsAny(p, "\\\x00\r\n\t") {
		return false
	}
	for _, part := range strings.Split(p, "/") {
		if part == "." || part == ".." || part == "" {
			return false
		}
	}
	return true
}
func isNotice(p string) bool {
	if sourceExtension.MatchString(p) {
		return false
	}
	for _, part := range strings.Split(path.Dir(p), "/") {
		if strings.EqualFold(part, "licenses") || strings.EqualFold(part, "licences") {
			return true
		}
	}
	return attributionName.MatchString(path.Base(p))
}

func validateInventory(in inventory) error {
	if in.SchemaVersion != 1 || !in.ReviewRequired || in.Binary.Path != "/usr/bin/caddy" || !shaPattern.MatchString(in.Binary.SHA256) || in.Binary.GoVersion == "" || in.Binary.MainModule == "" || len(in.Modules) == 0 || len(in.Modules) > 1000 {
		return errors.New("invalid pinned Go notice inventory")
	}
	for k, v := range map[string]string{"GOOS": "linux", "GOARCH": "amd64", "CGO_ENABLED": "0", "-trimpath": "true", "-tags": "nobadger,nomysql,nopgx"} {
		if in.Binary.BuildSettings[k] != v {
			return fmt.Errorf("missing pinned build setting %s", k)
		}
	}
	previous := ""
	mainFound := false
	for _, m := range in.Modules {
		if !safeRelative(m.Path) || !modulePattern.MatchString(m.Path) || !versionPattern.MatchString(m.Version) || !validSum(m.Sum) || m.Path <= previous || m.Notices == nil {
			return fmt.Errorf("invalid or duplicate module inventory: %s", m.Path)
		}
		previous = m.Path
		mainFound = mainFound || m.Path == in.Binary.MainModule
		priorNotice := ""
		for _, n := range m.Notices {
			if !safeRelative(n.Path) || !isNotice(n.Path) || n.Path <= priorNotice || n.Size <= 0 || n.Size > maxNotice || !shaPattern.MatchString(n.SHA256) {
				return fmt.Errorf("invalid expected notice in %s", m.Path)
			}
			priorNotice = n.Path
		}
	}
	if !mainFound {
		return errors.New("main module absent from inventory")
	}
	return nil
}

func validateBuild(info *debug.BuildInfo, in inventory) error {
	if info.GoVersion != in.Binary.GoVersion || info.Main.Path != in.Binary.MainModule {
		return errors.New("binary compiler/main module differs")
	}
	settings := map[string]string{}
	for _, s := range info.Settings {
		if _, exists := settings[s.Key]; exists {
			return errors.New("duplicate build setting")
		}
		settings[s.Key] = s.Value
	}
	if !reflect.DeepEqual(settings, in.Binary.BuildSettings) {
		return errors.New("binary build settings differ")
	}
	actual := append([]*debug.Module{&info.Main}, info.Deps...)
	if len(actual) != len(in.Modules) {
		return errors.New("compiled module inventory coverage differs")
	}
	sort.Slice(actual, func(i, j int) bool { return actual[i].Path < actual[j].Path })
	for i, m := range actual {
		expected := in.Modules[i]
		if m.Replace != nil || m.Path != expected.Path || m.Version != expected.Version || m.Sum != expected.Sum {
			return fmt.Errorf("compiled module identity differs: %s", m.Path)
		}
	}
	return nil
}

// Hash names and contents per Go's h1 contract; ZIP representation is separate.
// https://pkg.go.dev/golang.org/x/mod/sumdb/dirhash#Hash1
func inspectArchive(raw []byte, m module) (map[string][]byte, error) {
	if len(raw) > maxArchive {
		return nil, errors.New("module archive too large")
	}
	z, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return nil, err
	}
	if len(z.File) == 0 || len(z.File) > maxFiles {
		return nil, errors.New("invalid archive entry count")
	}
	files := append([]*zip.File(nil), z.File...)
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
	prefix := m.Path + "@" + m.Version + "/"
	seen := map[string]bool{}
	var total uint64
	for _, f := range files {
		rel := strings.TrimPrefix(f.Name, prefix)
		if rel == f.Name || !safeRelative(rel) || !f.Mode().IsRegular() || seen[strings.ToLower(f.Name)] {
			return nil, errors.New("unsafe, duplicate or unsupported archive path")
		}
		seen[strings.ToLower(f.Name)] = true
		if f.UncompressedSize64 > maxExpanded || total > maxExpanded-f.UncompressedSize64 {
			return nil, errors.New("expanded module archive too large")
		}
		total += f.UncompressedSize64
	}
	result := map[string][]byte{}
	outer := sha256.New()
	var noticeBytes int64
	for _, f := range files {
		rel := strings.TrimPrefix(f.Name, prefix)
		selected := isNotice(rel)
		if selected && (f.UncompressedSize64 > maxNotice || len(result) >= maxNotices) {
			return nil, errors.New("notice capture limit exceeded")
		}
		r, err := f.Open()
		if err != nil {
			return nil, err
		}
		inner := sha256.New()
		var content bytes.Buffer
		var writer io.Writer = inner
		if selected {
			writer = io.MultiWriter(inner, &content)
		}
		n, copyErr := io.Copy(writer, io.LimitReader(r, int64(f.UncompressedSize64)+1))
		closeErr := r.Close()
		if copyErr != nil || closeErr != nil || n != int64(f.UncompressedSize64) {
			return nil, errors.New("module entry content/size verification failed")
		}
		fmt.Fprintf(outer, "%x  %s\n", inner.Sum(nil), f.Name)
		if selected {
			if n == 0 || !utf8.Valid(content.Bytes()) || bytes.IndexByte(content.Bytes(), 0) >= 0 {
				return nil, errors.New("empty or unsupported notice encoding")
			}
			noticeBytes += n
			if noticeBytes > maxNoticeTotal {
				return nil, errors.New("total notice capture limit exceeded")
			}
			result[rel] = content.Bytes()
		}
	}
	if "h1:"+base64.StdEncoding.EncodeToString(outer.Sum(nil)) != m.Sum {
		return nil, errors.New("module ZIP h1 differs from compiled/pinned content")
	}
	if len(result) != len(m.Notices) {
		return nil, errors.New("discovered notice coverage differs from pinned inventory")
	}
	for _, n := range m.Notices {
		b, ok := result[n.Path]
		if !ok || int64(len(b)) != n.Size || digest(b) != n.SHA256 {
			return nil, fmt.Errorf("original notice differs: %s", n.Path)
		}
	}
	return result, nil
}

func escaped(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= 'A' && r <= 'Z' {
			b.WriteByte('!')
			b.WriteRune(r + 'a' - 'A')
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func cacheArchive(cache string, m module) ([]byte, error) {
	// go install need not retain every transitive .info response. A later
	// go mod download can therefore request the network even with a cached ZIP.
	// Read the exact named ZIP directly and authenticate its bytes independently;
	// neither mutable .ziphash nor download metadata is a content trust anchor.
	expected := filepath.Join(cache, "cache/download", escaped(m.Path), "@v", escaped(m.Version)+".zip")
	resolved, err := filepath.EvalSymlinks(expected)
	if err != nil || resolved != expected {
		return nil, errors.New("module cache archive path is not canonical")
	}
	stat, err := os.Lstat(expected)
	if err != nil || !stat.Mode().IsRegular() || stat.Size() > maxArchive {
		return nil, errors.New("module cache archive missing or oversized")
	}
	return os.ReadFile(expected)
}

func collect(binaryPath, inventoryPath, cache, output string) error {
	b, err := os.ReadFile(inventoryPath)
	if err != nil {
		return err
	}
	var in inventory
	decoder := json.NewDecoder(bytes.NewReader(b))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&in); err != nil {
		return err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("extra inventory JSON content")
	}
	if err := validateInventory(in); err != nil {
		return err
	}
	info, err := buildinfo.ReadFile(binaryPath)
	if err != nil {
		return err
	}
	if err := validateBuild(info, in); err != nil {
		return err
	}
	binaryBytes, err := os.ReadFile(binaryPath)
	if err != nil {
		return err
	}
	if digest(binaryBytes) != in.Binary.SHA256 {
		return errors.New("binary bytes differ from pinned inventory")
	}
	if _, err := os.Lstat(output); !errors.Is(err, os.ErrNotExist) {
		return errors.New("notice output must be a new directory")
	}
	if err := os.MkdirAll(output, 0755); err != nil {
		return err
	}
	result := manifest{1, true, "module-source-notice-superset", "offline-cache-zip-h1", digest(b), in.Binary, []moduleEvidence{}}
	var count int
	var total int64
	for _, m := range in.Modules {
		raw, err := cacheArchive(cache, m)
		if err != nil {
			return err
		}
		files, err := inspectArchive(raw, m)
		if err != nil {
			return fmt.Errorf("%s: %w", m.Path, err)
		}
		evidence := moduleEvidence{m.Path, m.Version, m.Sum, digest(raw), "collected", []shippedNotice{}}
		if len(m.Notices) == 0 {
			evidence.NoticeStatus = "missing"
		}
		moduleID := digest([]byte(m.Path + "@" + m.Version))
		for _, n := range m.Notices {
			count++
			total += n.Size
			if count > maxNotices || total > maxNoticeTotal {
				return errors.New("whole inventory notice limit exceeded")
			}
			destination := filepath.Join(output, moduleID, filepath.FromSlash(n.Path))
			if err := os.MkdirAll(filepath.Dir(destination), 0755); err != nil {
				return err
			}
			if err := os.WriteFile(destination, files[n.Path], 0644); err != nil {
				return err
			}
			evidence.Notices = append(evidence.Notices, shippedNotice{n, path.Join(imageRoot, moduleID, n.Path)})
		}
		result.Modules = append(result.Modules, evidence)
	}
	encoded, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		return err
	}
	// The index is written last; a failed collection cannot look complete.
	if err := os.WriteFile(filepath.Join(output, "index.json"), append(encoded, '\n'), 0644); err != nil {
		return err
	}
	fmt.Printf("Verified %d compiled modules and %d original attribution files; legal review required.\n", len(result.Modules), count)
	return nil
}

func main() {
	binaryPath := flag.String("binary", "/out/caddy", "compiled Caddy binary")
	inventoryPath := flag.String("inventory", "", "pinned module and notice inventory")
	cache := flag.String("cache", "/go/pkg/mod", "module cache from the same build")
	output := flag.String("output", "/out/notices/modules", "new original-notice output directory")
	flag.Parse()
	if err := collect(*binaryPath, *inventoryPath, *cache, *output); err != nil {
		fmt.Fprintln(os.Stderr, "Go notice collection failed:", err)
		os.Exit(1)
	}
}
