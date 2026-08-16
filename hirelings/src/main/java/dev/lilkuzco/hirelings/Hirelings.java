package dev.lilkuzco.hirelings;

import dev.lilkuzco.hirelings.command.HirelingsCommands;
import dev.lilkuzco.hirelings.entity.WorkerEntities;
import dev.lilkuzco.hirelings.entity.WorkerSpawns;
import dev.lilkuzco.hirelings.item.HirelingsItems;
import net.fabricmc.api.ModInitializer;
import net.minecraft.resources.Identifier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class Hirelings implements ModInitializer {
	public static final String MOD_ID = "hirelings";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	public static Identifier id(String path) {
		return Identifier.fromNamespaceAndPath(MOD_ID, path);
	}

	@Override
	public void onInitialize() {
		WorkerEntities.init();
		HirelingsItems.init();
		WorkerSpawns.init();
		HirelingsCommands.init();
		LOGGER.info("Hirelings initialized");
	}
}
