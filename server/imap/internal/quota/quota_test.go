package quota

import (
	"context"
	"errors"
	"testing"
)

func TestParseAndFormatSize(t *testing.T) {
	cases := map[string]int64{"": 0, "0": 0, "1024": 1024, "1KB": 1 << 10, "500MB": 500 << 20, "1gb": 1 << 30, "1.5GB": 3 << 29}
	for in, want := range cases {
		got, err := ParseSize(in)
		if err != nil || got != want {
			t.Errorf("ParseSize(%q) = %d, %v; want %d", in, got, err, want)
		}
	}
	if _, err := ParseSize("lots"); err == nil {
		t.Error("ParseSize(lots) should fail")
	}
	if FormatSize(2<<30) != "2GB" || FormatSize(0) != "unlimited" {
		t.Errorf("FormatSize = %s, %s", FormatSize(2<<30), FormatSize(0))
	}
}

type fixedUsage struct {
	u   Usage
	err error
}

func (f fixedUsage) Usage(context.Context, string) (Usage, error) { return f.u, f.err }

func TestCheck(t *testing.T) {
	ctx := context.Background()
	limit := Limit{StorageBytes: 100, Messages: 2}

	m := NewManager(Limit{}, fixedUsage{u: Usage{StorageBytes: 90, Messages: 1}})
	if err := m.Check(ctx, "a", limit, 5); err != nil {
		t.Errorf("under the limit: %v", err)
	}
	if err := m.Check(ctx, "a", limit, 20); !errors.Is(err, ErrExceeded) {
		t.Errorf("over storage: %v", err)
	}

	unknown := NewManager(Limit{}, fixedUsage{err: errors.New("not implemented")})
	if err := unknown.Check(ctx, "a", limit, 1<<40); err != nil {
		t.Errorf("unknown usage must not block mail: %v", err)
	}
}

func TestEffective(t *testing.T) {
	m := NewManager(Limit{Messages: 10}, nil)
	if m.Effective(nil).Messages != 10 {
		t.Error("default not used")
	}
	if m.Effective(&Limit{Messages: 5}).Messages != 5 {
		t.Error("override not used")
	}
}
