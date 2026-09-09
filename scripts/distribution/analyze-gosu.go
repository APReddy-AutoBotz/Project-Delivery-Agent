// Static ELF metadata analysis. The subject is never loaded or executed.
package main

import (
	"bytes"
	"crypto/sha256"
	"debug/buildinfo"
	"debug/elf"
	"debug/gosym"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"sort"
	"strings"
	"unicode/utf8"
)

func require(ok bool, message string) {
	if !ok {
		panic(message)
	}
}
func main() {
	require(len(os.Args) == 2, "one subject path required")
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	require(len(raw) == 1769900 && fmt.Sprintf("%x", sha256.Sum256(raw)) == "52c8749d0142edd234e9d6bd5237dff2d81e71f43537e2f4f66f75dd4b243dd0", "unreviewed subject")
	bi, err := buildinfo.Read(bytes.NewReader(raw))
	if err != nil {
		panic(err)
	}
	require(bi.GoVersion == "go1.24.6" && bi.Main.Path == "github.com/tianon/gosu" && bi.Main.Version == "v1.19.0", "unexpected build info")
	f, err := elf.NewFile(bytes.NewReader(raw))
	if err != nil {
		panic(err)
	}
	defer f.Close()
	require(f.Class == elf.ELFCLASS64 && f.Data == elf.ELFDATA2LSB && f.Machine == elf.EM_X86_64 && f.Type == elf.ET_EXEC, "unexpected ELF format")
	require(f.Section(".interp") == nil && f.Section(".dynamic") == nil, "unexpected dynamic loading")
	require(f.Section(".gopclntab") != nil && f.Section(".text") != nil, "missing Go metadata")
	pc, err := f.Section(".gopclntab").Data()
	if err != nil {
		panic(err)
	}
	require(len(pc) >= 72 && bytes.Equal(pc[:8], []byte{0xf1, 0xff, 0xff, 0xff, 0, 0, 1, 8}), "unsupported pclntab")
	word := func(i int) uint64 { return binary.LittleEndian.Uint64(pc[8+i*8 : 16+i*8]) }
	nfunc, nfiles, text := word(0), word(1), word(2)
	require(text == f.Section(".text").Addr, "text address mismatch")
	require(nfunc > 0 && nfunc < 100000 && nfiles > 0 && nfiles < 100000, "unbounded metadata")
	prev := uint64(72)
	for i := 3; i < 8; i++ {
		v := word(i)
		require(v >= prev && v < uint64(len(pc)), "invalid section range")
		prev = v
	}
	namesRaw := pc[word(3):word(4)]
	require(len(namesRaw) > 0 && namesRaw[len(namesRaw)-1] == 0, "unterminated name pool")
	names := []string{}
	nameSet := map[string]bool{}
	for _, n := range bytes.Split(namesRaw, []byte{0}) {
		if len(n) == 0 {
			continue
		}
		require(utf8.Valid(n), "invalid function name")
		s := string(n)
		names = append(names, s)
		nameSet[s] = true
	}
	table, err := gosym.NewTable(nil, gosym.NewLineTable(pc, text))
	if err != nil {
		panic(err)
	}
	require(uint64(len(table.Funcs)) == nfunc && uint64(len(table.Files)) == nfiles, "standard parser coverage mismatch")
	functions := []string{}
	tlsFunctions := []string{}
	tlsNames := []string{}
	tlsFiles := []string{}
	for i, fn := range table.Funcs {
		require(nameSet[fn.Name] && fn.Entry >= text && fn.End > fn.Entry && fn.End <= text+f.Section(".text").Size, "invalid decoded function")
		if i > 0 {
			require(table.Funcs[i-1].Entry < fn.Entry, "unordered functions")
		}
		functions = append(functions, fn.Name)
		if strings.Contains(fn.Name, "crypto/tls.") {
			tlsFunctions = append(tlsFunctions, fn.Name)
		}
	}
	require(table.LookupFunc("main.main") != nil && table.LookupFunc("main.SetupUser") != nil, "missing positive controls")
	for _, n := range names {
		if strings.Contains(n, "crypto/tls.") {
			tlsNames = append(tlsNames, n)
		}
	}
	files := []string{}
	for n := range table.Files {
		files = append(files, n)
		if strings.Contains(n, "crypto/tls/") {
			tlsFiles = append(tlsFiles, n)
		}
	}
	sort.Strings(files)
	sort.Strings(tlsFiles)
	// Query the entire emitted/inline name pool, not just exported or emitted
	// symbols. Include a present package as a negative control for exclusions.
	packages := []map[string]any{}
	for _, path := range []string{"crypto/tls", "crypto/x509", "encoding/asn1", "encoding/pem", "encoding/xml", "golang.org/x/net/http2", "golang.org/x/net/idna", "mime", "net", "net/http", "net/http/internal/http2", "net/mail", "net/url", "os"} {
		packageNames, packageFunctions, packageFiles := []string{}, []string{}, []string{}
		for _, name := range names {
			if strings.Contains(name, path+".") {
				packageNames = append(packageNames, name)
			}
		}
		for _, name := range functions {
			if strings.Contains(name, path+".") {
				packageFunctions = append(packageFunctions, name)
			}
		}
		for _, name := range files {
			if strings.HasPrefix(name, path+"/") || strings.Contains(name, "/"+path+"/") {
				packageFiles = append(packageFiles, name)
			}
		}
		packages = append(packages, map[string]any{"path": path, "names": packageNames, "functions": packageFunctions, "files": packageFiles})
	}
	encodeHash := func(v any) string {
		b, e := json.Marshal(v)
		if e != nil {
			panic(e)
		}
		return fmt.Sprintf("%x", sha256.Sum256(b))
	}
	result := map[string]any{
		"schemaVersion": 2, "method": "Go debug/elf + debug/buildinfo + debug/gosym and complete funcnametab",
		"toolchain": runtime.Version(), "subjectSha256": fmt.Sprintf("%x", sha256.Sum256(raw)), "subjectSize": len(raw),
		"goVersion": bi.GoVersion, "module": bi.Main.Path, "version": bi.Main.Version, "elfSections": len(f.Sections),
		"functions": len(functions), "files": len(files), "functionNames": len(names),
		"functionListSha256": encodeHash(functions), "fileListSha256": encodeHash(files), "nameListSha256": encodeHash(names),
		"nameTableSha256": fmt.Sprintf("%x", sha256.Sum256(namesRaw)), "pclntabSha256": fmt.Sprintf("%x", sha256.Sum256(pc)),
		"positiveControls": []string{"main.main", "main.SetupUser"}, "cryptoTlsFunctions": tlsFunctions, "cryptoTlsNames": tlsNames, "cryptoTlsFiles": tlsFiles,
		"coverageBasis":   "Go1.24.6 linker walkFuncs/generateFuncnametab includes every emitted function and inlined function; no module-only fallback",
		"subjectExecuted": false,
		"packages": packages,
	}
	e := json.NewEncoder(os.Stdout)
	e.SetIndent("", "  ")
	if err = e.Encode(result); err != nil {
		panic(err)
	}
}
