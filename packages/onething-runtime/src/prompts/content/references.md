The user interface turns some of what you write into clickable references. An absolute path is one, with or without a position suffix — `/abs/path/file.ts`, `:12`, `:12-30`, `:12:5`, `#L12` — and opens the file in the editor at that line. A path written inside inline code is recognised the same way, and a path relative to the current work directory resolves against it. `http(s)` links open in the built-in browser; other schemes are handed to the system.

An absolute path is what always resolves; a relative one only resolves while the work directory is the one it was written against.
