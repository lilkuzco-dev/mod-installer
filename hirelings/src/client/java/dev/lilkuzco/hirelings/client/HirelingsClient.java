package dev.lilkuzco.hirelings.client;

import dev.lilkuzco.hirelings.entity.WorkerEntities;
import net.fabricmc.api.ClientModInitializer;
import net.minecraft.client.renderer.entity.EntityRenderers;

public class HirelingsClient implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		EntityRenderers.register(WorkerEntities.WORKER, WorkerRenderer::new);
	}
}
