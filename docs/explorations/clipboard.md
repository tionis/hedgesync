# Exploration: a clipboard across devices

Status: built (`hedgesync clip`, text and images), 2026-11-16.

A fixed note used as a clipboard between machines and phones. Copy on the
laptop, open the note on the phone, and it is there. Type on the phone,
and `hedgesync clip paste` prints it on the laptop. Nothing to install on
the phone: it is a HedgeDoc note in a browser.

## What it would look like

```sh
hedgesync clip setup https://md.example.com   # creates a private note, remembers it
echo "some text" | hedgesync clip              # copy into the note
hedgesync clip paste                            # print the note (or the newest entry)
hedgesync clip watch --to-clipboard            # keep the local clipboard in sync
```

## Modes

- **Single value:** the note is the clipboard; copying replaces it. Simple,
  and what people expect from "clipboard".
- **History:** each copy is added at the top as an entry with time and
  device, under a heading; `paste` returns the newest entry, `paste 3` an
  older one. The note becomes a scratchpad of things passed around, and
  people can delete or edit entries by hand.

History is the more interesting one, and single value is history with one
entry.

## Syncing with the system clipboard

`clip watch` runs in the background (a user service) and:

- copies new entries from the note to the local clipboard (`wl-copy`,
  `xclip`, `pbcopy`, PowerShell `Set-Clipboard`),
- with `--from-clipboard`, adds what is copied locally to the note.

The second direction must be opt-in: everything copied, passwords from a
password manager included, would land in a note. Password managers mark
their clipboard entries (KDE's `x-kde-passwordManagerHint`, macOS
`org.nspasteboard.ConcealedType`), and the watcher must skip those, and
skip anything when in doubt.

## Images and files

HedgeDoc's image upload makes images work: a copied image is uploaded and
embedded, and `paste` downloads it. Files could go the same way, but that
becomes a file-transfer tool; images only is a good line.

## Security

- The note is created `private` (owner only). A device signed in to
  HedgeDoc as the same user sees it; nobody else does.
- History grows forever; `--keep 50` trims it.
- The local login cookie is what protects it, as with every hedgesync
  command.

## Suggested first step

`hedgesync clip setup|copy|paste` with a history note, plus `clip watch
--to-clipboard` for Wayland, X11 and macOS. About a day. The
from-clipboard direction (with the password-manager rules) and images
after that.
