# Hirelings

A Fabric mod for Minecraft 26.2 that adds persistent, player-hired workers.

## Getting a worker

Craft a **Help Wanted Notice** from one paper and one emerald, then place it on a
block with two blocks of clear space above it. An available worker will arrive.
Workers also spawn rarely in temperate overworld biomes. Give an available worker
**8 emeralds** to hire them.

## Assigning work

Right-click a worker you own while holding:

- a pickaxe to make them a miner;
- a hoe to make them a farmer;
- a fishing rod to make them a fisher;
- a sword, axe, bow, or crossbow to make them a hunter; or
- a clock to make them idle.

The assignment position becomes the center of a 16-block work area. Miners collect
reachable, exposed blocks in `hirelings:worker_mineable`, which contains vanilla
ores by default. Farmers harvest and replant mature vanilla crops. Fishers use normal
lake, river, and constructed-pool shores. Hunters engage monsters and common adult
livestock inside their work area. Mining and farming respect `mob_griefing`.

Workers have a private 18-slot inventory and collect their job drops. Right-click
with an empty hand for status; sneak-right-click with an empty hand to collect their
inventory. Contents drop normally if a worker dies. Hired workers persist and idle
workers follow their employer.

## Commands

- `/hirelings status` lists your currently loaded workers.
- `/hirelings recall` safely recalls your loaded workers in the current dimension
  and makes the arrival point their new work center.
- `/hirelings summon` creates an available worker and requires operator permission.

Like other mobs, workers only perform jobs while their chunk is loaded.

## Development

Requires JDK 25. Run `./gradlew clean build`; the remapped production JAR is written
to `build/libs/hirelings-0.1.0.jar`. See `VERIFY.md` for the release test record.
