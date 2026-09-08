package main

import (
	"archive/zip"
	"bytes"
	"os"
	"runtime/debug"
	"strings"
	"testing"
)

type entry struct {
	name, content string
	mode          os.FileMode
}

func fixtureModule() module {
	return module{"example.com/Case/mod/v2", "v2.0.0", "h1:QMkM0PPPl/I6jaz7tlwB1Ank9phwwM0O9k3bWYKf7og=", []notice{
		{"LICENSE", 18, "c171da380a617eccf222a3ed1d596a9c905edde4e19bfd7e0fb4f4da5e5f49ea"},
		{"nested/NOTICE", 16, "5c94a7223528876ae5b37d57645745371cf6e103b8d10efdb54e020ab1a8cd32"},
	}}
}
func fixtureEntries() []entry {
	return []entry{{"LICENSE", "Original license\r\n", 0644}, {"nested/NOTICE", "Original notice\n", 0644}, {"main.go", "package fixture\n", 0644}}
}
func archive(t *testing.T, entries []entry, method uint16) []byte {
	t.Helper()
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	for _, e := range entries {
		h := &zip.FileHeader{Name: "example.com/Case/mod/v2@v2.0.0/" + e.name, Method: method}
		h.SetMode(e.mode)
		w, err := z.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(e.content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func TestOriginalBytesAndContentIdentity(t *testing.T) {
	entries := fixtureEntries()
	one := archive(t, entries, zip.Store)
	entries[0], entries[2] = entries[2], entries[0]
	two := archive(t, entries, zip.Deflate)
	if digest(one) == digest(two) {
		t.Fatal("independent archive encodings should differ")
	}
	for _, raw := range [][]byte{one, two} {
		files, err := inspectArchive(raw, fixtureModule())
		if err != nil {
			t.Fatal(err)
		}
		if string(files["LICENSE"]) != "Original license\r\n" || string(files["nested/NOTICE"]) != "Original notice\n" || len(files) != 2 {
			t.Fatal("original byte/path preservation failed")
		}
	}
}
func TestArchiveTampering(t *testing.T) {
	for _, name := range []string{"source", "notice", "h1", "version", "notice-hash", "notice-size", "omitted-nested-index"} {
		t.Run(name, func(t *testing.T) {
			m, entries := fixtureModule(), fixtureEntries()
			switch name {
			case "source":
				entries[2].content = "package changed\n"
			case "notice":
				entries[0].content = "Replaced license\r\n"
			case "h1":
				m.Sum = "h1:" + strings.Repeat("A", 43) + "="
			case "version":
				m.Version = "v2.0.1"
			case "notice-hash":
				m.Notices[0].SHA256 = strings.Repeat("b", 64)
			case "notice-size":
				m.Notices[0].Size++
			case "omitted-nested-index":
				m.Notices = m.Notices[:1]
			}
			if _, err := inspectArchive(archive(t, entries, zip.Store), m); err == nil {
				t.Fatal("changed source or pinned attribution accepted")
			}
		})
	}
}
func TestUnsafeArchivePaths(t *testing.T) {
	for _, e := range []entry{
		{"../LICENSE", "escape", 0644}, {"/LICENSE", "absolute", 0644}, {"nested\\LICENSE", "backslash", 0644},
		{"LICENSE", "duplicate", 0644}, {"license", "case collision", 0644}, {"link", "LICENSE", os.ModeSymlink | 0777},
		{"empty/", "", os.ModeDir | 0755}, {"nested\nLICENSE", "newline", 0644},
	} {
		t.Run(e.name, func(t *testing.T) {
			_, err := inspectArchive(archive(t, append(fixtureEntries(), e), zip.Store), fixtureModule())
			if err == nil || !strings.Contains(err.Error(), "path") {
				t.Fatalf("unsafe path not rejected before hashing: %v", err)
			}
		})
	}
}
func TestNoticeCaptureBoundsAndTypes(t *testing.T) {
	for _, content := range []string{"", "invalid\xff", "nul\x00text", strings.Repeat("x", maxNotice+1)} {
		entries := fixtureEntries()
		entries[0].content = content
		if _, err := inspectArchive(archive(t, entries, zip.Deflate), fixtureModule()); err == nil {
			t.Fatal("unsupported notice accepted")
		}
	}
	for _, p := range []string{"nested/LICENSE.txt", "NOTICE", "Copyright", "COPYING.BSD", "AUTHORS", "PATENTS", "THIRD_PARTY_NOTICES.txt", "LICENSES/MIT.txt"} {
		if !isNotice(p) {
			t.Errorf("missing attribution pattern %s", p)
		}
	}
	for _, p := range []string{"license.go", "testdata/license.json", "LICENSES/example.js", "NOTICE.png", "main.go"} {
		if isNotice(p) {
			t.Errorf("source/data file captured as a notice: %s", p)
		}
	}
	if escaped("example.com/Case/mod/v2") != "example.com/!case/mod/v2" {
		t.Fatal("module case encoding differs")
	}
}
func buildFixture() (inventory, *debug.BuildInfo) {
	m := fixtureModule()
	settings := map[string]string{"GOOS": "linux", "GOARCH": "amd64", "CGO_ENABLED": "0", "-trimpath": "true", "-tags": "nobadger,nomysql,nopgx"}
	in := inventory{1, true, binary{"/usr/bin/caddy", strings.Repeat("a", 64), "go1.26.8", m.Path, settings}, []module{m}}
	info := &debug.BuildInfo{GoVersion: in.Binary.GoVersion, Main: debug.Module{Path: m.Path, Version: m.Version, Sum: m.Sum}}
	for k, v := range settings {
		info.Settings = append(info.Settings, debug.BuildSetting{Key: k, Value: v})
	}
	return in, info
}
func TestCompiledInventoryBoundary(t *testing.T) {
	in, info := buildFixture()
	if err := validateInventory(in); err != nil {
		t.Fatal(err)
	}
	if err := validateBuild(info, in); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"replacement", "sum", "version", "extra-module", "compiler", "settings", "duplicate-setting"} {
		t.Run(name, func(t *testing.T) {
			in, info := buildFixture()
			switch name {
			case "replacement":
				info.Main.Replace = &debug.Module{Path: "example.com/other"}
			case "sum":
				info.Main.Sum = ""
			case "version":
				info.Main.Version = "v2.1.0"
			case "extra-module":
				info.Deps = append(info.Deps, &debug.Module{Path: "example.com/extra"})
			case "compiler":
				info.GoVersion = "go1.26.3"
			case "settings":
				info.Settings = info.Settings[:len(info.Settings)-1]
			case "duplicate-setting":
				info.Settings = append(info.Settings, info.Settings[0])
			}
			if err := validateBuild(info, in); err == nil {
				t.Fatal("changed build identity accepted")
			}
		})
	}
	in.Modules = append(in.Modules, in.Modules[0])
	if err := validateInventory(in); err == nil {
		t.Fatal("duplicate pinned module accepted")
	}
}
