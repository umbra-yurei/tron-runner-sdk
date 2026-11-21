// Packs a Go module directory the way the module proxy serves a release (a module zip, its go.mod and an info file)
// into a directory a file:// GOPROXY can read. Arguments: <module-directory> <module-path> <version> <proxy-directory>.
// Standard library only, so it needs no module.
package main

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type versionInfo struct {
	Version string
	Time    time.Time
}

func main() {
	if len(os.Args) != 5 {
		fail(fmt.Errorf("usage: go run modproxy.go <module-directory> <module-path> <version> <proxy-directory>"))
	}
	moduleDirectory, modulePath, version, proxyDirectory := os.Args[1], os.Args[2], os.Args[3], os.Args[4]
	versions := filepath.Join(proxyDirectory, filepath.FromSlash(modulePath), "@v")
	check(os.MkdirAll(versions, 0o755))

	archive, err := os.Create(filepath.Join(versions, version+".zip"))
	check(err)
	writer := zip.NewWriter(archive)
	prefix := modulePath + "@" + version + "/"
	check(filepath.WalkDir(moduleDirectory, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(moduleDirectory, path)
		if err != nil {
			return err
		}
		if entry.IsDir() {
			// A nested module is not part of this one, and VCS metadata never ships.
			if relative != "." && (entry.Name() == ".git" || entry.Name() == "vendor" || fileExists(filepath.Join(path, "go.mod"))) {
				return filepath.SkipDir
			}
			return nil
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		target, err := writer.Create(prefix + filepath.ToSlash(relative))
		if err != nil {
			return err
		}
		source, err := os.Open(path)
		if err != nil {
			return err
		}
		defer source.Close()
		_, err = io.Copy(target, source)
		return err
	}))
	check(writer.Close())
	check(archive.Close())

	goMod, err := os.ReadFile(filepath.Join(moduleDirectory, "go.mod"))
	check(err)
	check(os.WriteFile(filepath.Join(versions, version+".mod"), goMod, 0o644))
	info, err := json.Marshal(versionInfo{Version: version, Time: time.Now().UTC()})
	check(err)
	check(os.WriteFile(filepath.Join(versions, version+".info"), info, 0o644))
	check(os.WriteFile(filepath.Join(versions, "list"), []byte(strings.TrimSpace(version)+"\n"), 0o644))
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func check(err error) {
	if err != nil {
		fail(err)
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
