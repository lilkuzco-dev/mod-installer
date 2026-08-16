package dev.lilkuzco.hirelings.client;

import dev.lilkuzco.hirelings.entity.WorkerEntity;
import net.minecraft.client.model.geom.ModelLayers;
import net.minecraft.client.model.player.PlayerModel;
import net.minecraft.client.renderer.entity.EntityRendererProvider;
import net.minecraft.client.renderer.entity.HumanoidMobRenderer;
import net.minecraft.client.renderer.entity.state.AvatarRenderState;
import net.minecraft.resources.Identifier;

/** Vanilla player-shaped worker, rendered entirely through the 26.2 render-state pipeline. */
public class WorkerRenderer extends HumanoidMobRenderer<WorkerEntity, AvatarRenderState, PlayerModel> {
	private static final Identifier TEXTURE =
			Identifier.fromNamespaceAndPath("minecraft", "textures/entity/player/wide/steve.png");

	public WorkerRenderer(EntityRendererProvider.Context context) {
		super(context, new PlayerModel(context.bakeLayer(ModelLayers.PLAYER), false),
				new PlayerModel(context.bakeLayer(ModelLayers.PLAYER), false), 0.5F);
	}

	@Override
	public AvatarRenderState createRenderState() {
		return new AvatarRenderState();
	}

	@Override
	public Identifier getTextureLocation(AvatarRenderState state) {
		return TEXTURE;
	}

	@Override
	public void extractRenderState(WorkerEntity entity, AvatarRenderState state, float partialTicks) {
		super.extractRenderState(entity, state, partialTicks);
		state.showHat = true;
		state.showJacket = true;
		state.showLeftSleeve = true;
		state.showRightSleeve = true;
		state.showLeftPants = true;
		state.showRightPants = true;
		state.showCape = false;
	}
}
