# Third-party notices

`memmy-history-recorder` statically includes one third-party component.

## nlohmann/json 3.12.0

- Source: https://github.com/nlohmann/json/releases/download/v3.12.0/json.hpp
- SHA-256: `aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63`
- Upstream signature: `json.hpp.asc` from the same release, made with key
  `7971 67AE 41C0 A6D9 232E 4845 7F3C EA63 AE25 1B69` (Niels Lohmann). The signature was verified
  on 2026-10-01; the build itself verifies only the pinned SHA-256 (see `cmake/NlohmannJson.cmake`).
- License: MIT

```
MIT License

Copyright (c) 2013-2025 Niels Lohmann

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The Microsoft C/C++ runtime is linked statically under the terms of the Visual Studio
license; all other imports are Windows system DLLs.
