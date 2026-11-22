package inputs

import (
	"os"
	"testing"
)

func TestFixture(t *testing.T) {
	data, err := os.ReadFile("testdata/fixture.txt")
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "alpha\n" {
		t.Fatalf("testdata/fixture.txt = %q, want %q", data, "alpha\n")
	}
	entries, err := os.ReadDir("testdata")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("testdata holds %d entries, want 1", len(entries))
	}
}
