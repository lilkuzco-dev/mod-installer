# Hirelings 0.1.0 verification

Date: 2026-08-15. Target: Minecraft 26.2, Fabric Loader 0.19.3,
Fabric API 0.157.0+26.2, Loom 1.17, Gradle 9.5.1, JDK 25.

## Build and launch

- `./gradlew clean build` — PASS with deprecation lint enabled and zero warnings.
- Dedicated server — PASS. Recipes, advancements, entity registration, and all eight
  biome spawn modifications load; startup reaches `Done` and shutdown is clean.
- Client — PASS. Hirelings initializes through renderer registration, resource
  reload, item-atlas creation, sound startup, and the title screen without a mod
  error or crash.
- Pack inspection — PASS. The remapped JAR contains common/client classes, metadata,
  translations, item definition/model, recipe/advancement, and both data tags.

## Automated live-world battery

The battery used Carpet fake players only as a test driver; Carpet is not a runtime
dependency of the production mod.

- Help Wanted Notice placement and entity persistence — PASS.
- Survival hiring — PASS; exactly eight emeralds are consumed.
- Job assignment and owner-only access — PASS; a second player cannot reassign the
  worker or collect its inventory.
- Mining — PASS; a reachable diamond ore is broken and one diamond is stored.
- Farming — PASS; mature wheat is harvested, replanted at age zero, and net drops are
  stored.
- Fishing — PASS; a standard one-block-lower shoreline is selected and a cod is
  stored. Both same-level constructed shores and normal lake/river shores are
  supported.
- Hunting — PASS; an adult cow inside the work area is killed and beef/leather are
  collected.
- `mob_griefing=false` — PASS; both ore and mature crop remain unchanged.
- Inventory collection and death handling — PASS; sneak interaction transfers all
  carried stacks and carried contents drop when the worker dies.
- Save/restart — PASS; owner, job, home, and a mixed inventory survive a clean full
  server restart.
- Status and recall commands — PASS; two recalled workers use separate supported,
  collision-free positions and update their homes.
- Defensive persistence — PASS; invalid owner UUID data loads as an unhired worker
  instead of crashing the world.

## Intentional boundaries

Workers do not force chunks to stay loaded. Miners target exposed/reachable tagged
ores rather than digging arbitrary tunnels, preventing uncontrolled excavation and
unbounded pathing. Commands report and recall only workers loaded in the player's
current dimension.
