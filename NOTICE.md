# Third-party notices

## Path of Building Community

This project embeds and derives from Path of Building Community, and ports
portions of its passive tree rendering logic.

- Source: https://github.com/PathOfBuildingCommunity/PathOfBuilding
- Licence: MIT
- Copyright (c) 2016 David Gowor, and the Path of Building Community
  contributors (398 contributors as of 2026-08).

```
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

### What we use, and where

| Ours | Derived from |
|---|---|
| `engine-host/` | Drives PoB's calculation engine unmodified via `src/HeadlessWrapper.lua` |
| `engine-host/lua/api/tree.lua` | Geometry export ported from `PassiveTree.lua` (`CalcOrbitAngles`, `BuildConnector`, sprite map) |
| `packages/tree-renderer/` | Rendering logic ported from `PassiveTreeView.lua` — draw order, sprite-state selection, connector meshes, hit radii |
| Game data | Consumed from PoB's published `manifest.xml`; not redistributed by us |

Any file containing ported logic carries a header pointing at the PoB source
file and the functions it came from, so the provenance stays traceable.

Path of Exile is a trademark of Grinding Gear Games. This project is not
affiliated with or endorsed by Grinding Gear Games or by Path of Building
Community.
