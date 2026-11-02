package main

import (
	"os"
	"path/filepath"
	"testing"
)

func setup(t *testing.T) *Store {
	t.Helper()
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "music"), 0o755)
	for _, f := range []string{"27 HM Jollies.m4a", "06 Royal Salute.m4a", "notes.txt", ".hidden.m4a"} {
		os.WriteFile(filepath.Join(root, "music", f), []byte("x"), 0o644)
	}
	s, err := NewStore(root)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestRescanAndCategories(t *testing.T) {
	s := setup(t)
	lib := s.Library()
	if len(lib) != 2 {
		t.Fatalf("want 2 tracks, got %d", len(lib))
	}
	if lib[0].Title != "Royal Salute" || lib[0].Category != "Salutes" || lib[0].Order != 6 {
		t.Fatalf("bad guess: %+v", lib[0])
	}
	os.Remove(filepath.Join(s.musicDir, "27 HM Jollies.m4a"))
	s.Rescan()
	for _, tr := range s.Library() {
		if tr.Title == "HM Jollies" && !tr.Missing {
			t.Fatal("removed file should be marked missing")
		}
	}
	// reload from disk keeps state
	s2, err := NewStore(s.root)
	if err != nil || len(s2.Library()) != 2 {
		t.Fatalf("reload failed: %v", err)
	}
}

func TestParadeLifecycle(t *testing.T) {
	s := setup(t)
	tid := s.Library()[0].ID
	if _, err := s.SaveParade(Parade{Name: "x", Items: []Item{{TrackID: "nope"}}}); err == nil {
		t.Fatal("invalid track id should be rejected")
	}
	p, err := s.SaveParade(Parade{Name: "  Daily Parade ", Items: []Item{{TrackID: tid, Transition: "weird"}}})
	if err != nil {
		t.Fatal(err)
	}
	if p.Name != "Daily Parade" || p.Items[0].Transition != "beat" || p.Items[0].UID == "" {
		t.Fatalf("not sanitised: %+v", p)
	}
	p.Name = "Renamed"
	if _, err := s.SaveParade(*p); err != nil {
		t.Fatal(err)
	}
	if got, _ := s.Parade(p.ID); got.Name != "Renamed" || got.Created.IsZero() {
		t.Fatalf("update failed: %+v", got)
	}
	if _, err := s.Parade("../../etc"); err != errNotFound {
		t.Fatal("path traversal must be rejected")
	}
	b := s.Export()
	if err := s.DeleteParade(p.ID); err != nil || len(s.Parades()) != 0 {
		t.Fatal("delete failed")
	}
	if _, err := s.Restore(b); err != nil || len(s.Parades()) != 1 {
		t.Fatalf("restore failed: %v", err)
	}
}

func TestPatchTrackAndUpload(t *testing.T) {
	s := setup(t)
	id := s.Library()[0].ID
	pts := []float64{3.21234, -1, 1.5}
	g := 9.0
	tr, err := s.PatchTrack(id, TrackPatch{Points: &pts, Gain: &g})
	if err != nil || len(tr.Points) != 2 || tr.Points[0] != 1.5 || tr.Gain != 1 {
		t.Fatalf("patch not validated: %+v %v", tr, err)
	}
	name, err := s.SaveUpload(`..\..\06 Royal Salute.m4a`, func(f *os.File) error { _, e := f.WriteString("y"); return e })
	if err != nil || name != "06 Royal Salute (2).m4a" {
		t.Fatalf("upload naming: %q %v", name, err)
	}
	if _, err := s.SaveUpload("evil.exe", func(f *os.File) error { return nil }); err == nil {
		t.Fatal("non-audio upload must be rejected")
	}
}

func TestFavouritesSanitised(t *testing.T) {
	s := setup(t)
	v := s.Settings()
	v.Favourites = []string{"abcdef123456", "abcdef123456", "../x", "111111111111", "2", "333333333333", "444444444444", "555555555555", "666666666666", "777777777777", "888888888888", "999999999999"}
	out, err := s.SaveSettings(v)
	if err != nil || len(out.Favourites) != 9 || out.Favourites[0] != "abcdef123456" || out.Favourites[1] != "111111111111" {
		t.Fatalf("bad favourites: %v %v", out.Favourites, err)
	}
}

func TestPresetUpgrade(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "music"), 0o755)
	os.MkdirAll(filepath.Join(root, "data"), 0o755)
	f := "24 Slow to Quick - Navy.m4a"
	os.WriteFile(filepath.Join(root, "music", f), []byte("x"), 0o644)
	s, _ := NewStore(root) // no presets yet: guessed, AV 0
	writeJSON(filepath.Join(root, "data", "presets.json"), map[string]*Track{f: {Title: "x", BPM: 69, BPM2: 116, Change: 32, AV: 2, Beats: []float64{1, 2}, Points: []float64{1}}})
	s.Rescan()
	tr := s.Library()[0]
	if tr.AV != 2 || tr.Change != 32 || len(tr.Points) != 1 || tr.Title == "x" {
		t.Fatalf("upgrade wrong: %+v", tr)
	}
	ck := true
	s.PatchTrack(tr.ID, TrackPatch{Checked: &ck})
	writeJSON(filepath.Join(root, "data", "presets.json"), map[string]*Track{f: {AV: 3, Change: 50}})
	s.Rescan()
	if s.Library()[0].Change != 32 {
		t.Fatal("checked track must not be overwritten")
	}
}

func TestTrim(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "music"), 0o755)
	os.MkdirAll(filepath.Join(root, "data"), 0o755)
	f := "06 Royal Salute.m4a"
	os.WriteFile(filepath.Join(root, "music", f), []byte("x"), 0o644)
	s, _ := NewStore(root)
	writeJSON(filepath.Join(root, "data", "presets.json"), map[string]*Track{f: {Duration: 21.7, TrimStart: 0.6, TrimEnd: 18.4}})
	s.Rescan()
	tr := s.Library()[0]
	if tr.TrimStart != 0.6 || tr.TrimEnd != 18.4 {
		t.Fatalf("trim not upgraded: %+v", tr)
	}
	d := 21.7
	s.PatchTrack(tr.ID, TrackPatch{Duration: &d})
	bad := 5.0
	if _, err := s.PatchTrack(tr.ID, TrackPatch{TrimEnd: &bad, TrimStart: &d}); err == nil {
		t.Fatal("end before start must be rejected")
	}
	a, b, yes := 1.0, 17.0, true
	if _, err := s.PatchTrack(tr.ID, TrackPatch{TrimStart: &a, TrimEnd: &b, TrimSet: &yes}); err != nil {
		t.Fatal(err)
	}
	writeJSON(filepath.Join(root, "data", "presets.json"), map[string]*Track{f: {TrimStart: 0.1, TrimEnd: 20}})
	s.Rescan()
	if got := s.Library()[0]; got.TrimStart != 1 || got.TrimEnd != 17 {
		t.Fatalf("hand-set trim was overwritten: %+v", got)
	}
}

func TestAutoRollPersists(t *testing.T) {
	s := setup(t)
	tid := s.Library()[0].ID
	p, err := s.SaveParade(Parade{Name: "roll", Items: []Item{{TrackID: tid, Auto: true}, {TrackID: tid}}})
	if err != nil {
		t.Fatal(err)
	}
	got, _ := s.Parade(p.ID)
	if !got.Items[0].Auto || got.Items[1].Auto {
		t.Fatalf("auto flag lost: %+v", got.Items)
	}
}
