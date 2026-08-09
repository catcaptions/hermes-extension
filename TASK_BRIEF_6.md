# TASK_BRIEF_6 — stop __pycache__ from ever appearing in the extension root

Repo: `C:\projects\browser-extensions\hermes-minimal-extension` (HEAD `0e3e957`; 62 renderer tests green).

## Problem (user hit it live)

Chrome/Edge REFUSE to load an unpacked extension whose root contains a name starting with `_`:
`Failed to load extension — Cannot load extension with file or directory name __pycache__. Filenames starting with "_" are reserved for use by the system.`
The `__pycache__/` dir is created whenever anyone runs `python -m py_compile media-bridge.py` (or the bridge is run by plain `python` instead of `pythonw`... actually pythonw also writes bytecode cache). The orchestrator just deleted it to unblock the user — the fix must prevent regeneration.

## Required changes

1. **media-bridge.py — top of file, before any other logic** (right after the module docstring / imports):
   ```python
   import sys
   sys.dont_write_bytecode = True
   ```
   This makes the bridge NEVER write `.pyc`/`__pycache__`, no matter how it's launched (.lnk autostart, media-bridge.bat, pythonw, python).

2. **media-bridge.bat** — change `pythonw media-bridge.py` → `pythonw -B media-bridge.py` (belt and braces).

3. **README.md** — add a short "Verification note": `media-bridge.py` must be syntax-checked WITHOUT creating `__pycache__` in the extension root (Chrome/Edge refuse `_`-prefixed names at the extension root). Use:
   `python -B -c "import ast; ast.parse(open('media-bridge.py', encoding='utf-8').read()); print('OK')"`
   If you ever run `python -m py_compile`, you MUST `rm -rf __pycache__` afterward and confirm it's gone.

4. **Verify, carefully**:
   - `node --check sidepanel.js` (untouched)
   - `node test_renderer.js` → 62/62
   - Syntax-check media-bridge.py with the ast.parse one-liner above (NOT py_compile)
   - `ls -a | grep '^_'` → must be empty when you're done (this is the acceptance check)
5. Do NOT touch renderer.js, sidepanel.js, or tests. Commit; reply exactly `NO_PYCACHE_DONE` + 2-line summary.
