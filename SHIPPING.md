# Shipping convention

The ship stage for every mod in the group (vibranium, warfront, menagerie, …) and for
the installer itself ends the same way, and it is not where it used to end.

> **Ship is not done when the release is live; ship is done when postship-check passes.**

Born from the v0.2.0 Garrison incident: the warfront release was live on GitHub and the
manifest was pushed, but the machine that reported "bases are broken" was still running
the previous jar — nobody had run the sync. Hours went into diagnosing a structure
pipeline that had never loaded.

## The ship checklist

1. **Build** the release artifact (`./gradlew build` for mods; `node build.js` for the
   installer binaries).
2. **Tag + release** on GitHub with the artifact attached (`gh release create vX.Y.Z …`).
3. **Manifest bump**: update `mods.json` (`filename`, `url`, `sha512` — `shasum -a 512`
   the exact file you attached) and push.
4. **Gate**: run

   ```sh
   tools/postship-check.sh
   ```

   It syncs the local mods folder, re-runs the installer `--dry-run` and requires a
   zero-change plan, independently re-hashes every `extra_mods` jar against the
   manifest, and then verifies the whole set can actually **load**. Any divergence
   prints a mismatch table and exits nonzero.

   The load step reads every jar's own `fabric.mod.json` — nested `META-INF/jars/`
   included — and requires every declared dependency to be satisfied by something else
   in the manifest. It exists because the first three steps all passed on a manifest
   shipping `kinetics 0.1.1` beside a `cosmos` requiring `>=0.1.2`: the hashes were
   perfect and the mod set would not have started. **Hashes matching is not the same as
   mods starting.**

   Run it alone with `node tools/load-check.js --side server` when preparing the server
   mirror.
5. Only after the gate passes: announce, verify in-game, write VERIFY entries.

In-game verification of worldgen changes needs **fresh chunks** — and for structure
work, prefer a **fresh world**: chunks generated under the previous version keep its
structures forever, which will faithfully reproduce the bug you just fixed.
