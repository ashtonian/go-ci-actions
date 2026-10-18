package contract

import (
	"testing"

	"example.com/go-ci-leaf"
)

func TestBuildInputs(t *testing.T) {
	if got := leaf.Answer; got != 42 {
		t.Fatal(got)
	}
}
