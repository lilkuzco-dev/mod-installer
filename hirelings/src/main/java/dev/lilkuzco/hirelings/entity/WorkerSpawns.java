package dev.lilkuzco.hirelings.entity;

import dev.lilkuzco.hirelings.Hirelings;
import net.fabricmc.fabric.api.biome.v1.BiomeModifications;
import net.fabricmc.fabric.api.biome.v1.BiomeSelectors;
import net.minecraft.core.registries.Registries;
import net.minecraft.tags.TagKey;
import net.minecraft.world.entity.MobCategory;
import net.minecraft.world.level.biome.Biome;

/** Rare unaffiliated workers found in settled, temperate biomes. */
public final class WorkerSpawns {
	public static final TagKey<Biome> WORKER_SPAWNS = TagKey.create(Registries.BIOME, Hirelings.id("worker_spawns"));

	public static void init() {
		BiomeModifications.addSpawn(BiomeSelectors.tag(WORKER_SPAWNS), MobCategory.CREATURE,
				WorkerEntities.WORKER, 2, 1, 2);
	}

	private WorkerSpawns() {
	}
}
