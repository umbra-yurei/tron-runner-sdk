// Decodes each sample with the generated Go bindings and writes it back out re-encoded.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"bindingcheck/generated"
)

func roundTrip[T any](data []byte, unmarshal func([]byte) (T, error), marshal func(*T) ([]byte, error)) []byte {
	decoded, err := unmarshal(data)
	if err != nil {
		panic(err)
	}
	encoded, err := marshal(&decoded)
	if err != nil {
		panic(err)
	}
	return encoded
}

func main() {
	inputDir, outputDir := os.Args[1], os.Args[2]
	entries, err := os.ReadDir(inputDir)
	if err != nil {
		panic(err)
	}
	for _, entry := range entries {
		data, err := os.ReadFile(filepath.Join(inputDir, entry.Name()))
		if err != nil {
			panic(err)
		}
		var encoded []byte
		switch strings.SplitN(entry.Name(), ".", 2)[0] {
		case "WorkFrame":
			encoded = roundTrip(data, generated.UnmarshalWorkFrame, (*generated.WorkFrame).Marshal)
		case "ReportFrame":
			encoded = roundTrip(data, generated.UnmarshalReportFrame, (*generated.ReportFrame).Marshal)
		case "AnnounceFrame":
			encoded = roundTrip(data, generated.UnmarshalAnnounceFrame, (*generated.AnnounceFrame).Marshal)
		case "StartCommand":
			encoded = roundTrip(data, generated.UnmarshalStartCommand, (*generated.StartCommand).Marshal)
		default:
			panic(fmt.Sprintf("no consumer for sample %s", entry.Name()))
		}
		if err := os.WriteFile(filepath.Join(outputDir, entry.Name()), encoded, 0o644); err != nil {
			panic(err)
		}
	}
}
