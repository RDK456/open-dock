# Hyperframes Composition Brief: Open Dock

## Output
- Composition: `composition/` (standalone `index.html`, GSAP, one paused timeline)
- Render: `brag.mp4`, landscape 1920x1080, 24s

## Source material
- Project root: F:\projects\deck\open-dock
- Read: README.md, phone-app/src/app/(tabs)/{index,touch,voice,camera,connect}.tsx, git log, live phone screenshots (adb)
- Verbatim copy: "Your phone is a PC dock.", "Use this phone as a webcam for your PC.", "Listening. Say the command.", "Pair once. Switch modes without scanning again.", "Free and open source.", github.com/RDK456/open-dock
- Real UI: new Connect screenshot (assets/img/connect.png); deck/camera/pet recreated in HTML.

## Creative direction
app-store tone, smooth slides and crossfades, short readable labels. See brag-plan.md storyboard (contract).

## Audio
bed.mp3 (vol-1, 120 BPM) + sparse SFX copied into composition/assets. Cue locks: 18.02s (screenshot lands), 21.01s (logo). Audio-reactive skipped; documented.

## Requirements
Show real UI; keep text readable; 24s; `hyperframes check` clean before render; local only.
