package dev.lilkuzco.hirelings.item;

import dev.lilkuzco.hirelings.entity.WorkerEntities;
import dev.lilkuzco.hirelings.entity.WorkerEntity;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.context.UseOnContext;

/** Survival-safe acquisition: place a notice to call one persistent, unhired worker. */
public class HelpWantedNoticeItem extends Item {
	public HelpWantedNoticeItem(Properties properties) {
		super(properties);
	}

	@Override
	public InteractionResult useOn(UseOnContext context) {
		Player player = context.getPlayer();
		if (!(context.getLevel() instanceof ServerLevel level) || player == null) {
			return InteractionResult.SUCCESS;
		}
		var spawnPos = context.getClickedPos().relative(context.getClickedFace());
		WorkerEntity worker = WorkerEntities.WORKER.create(level, EntitySpawnReason.SPAWN_ITEM_USE);
		if (worker == null) {
			return InteractionResult.FAIL;
		}
		worker.snapTo(spawnPos.getX() + 0.5, spawnPos.getY(), spawnPos.getZ() + 0.5,
				player.getYRot() + 180.0F, 0.0F);
		if (!level.noCollision(worker)) {
			player.sendSystemMessage(Component.translatable("message.hirelings.notice_blocked"));
			return InteractionResult.FAIL;
		}
		worker.setPersistenceRequired();
		if (!level.addFreshEntity(worker)) {
			return InteractionResult.FAIL;
		}
		context.getItemInHand().consume(1, player);
		player.sendSystemMessage(Component.translatable("message.hirelings.notice_used"));
		return InteractionResult.SUCCESS;
	}

}
