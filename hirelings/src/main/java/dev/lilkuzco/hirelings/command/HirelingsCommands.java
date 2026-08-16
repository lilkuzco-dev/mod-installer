package dev.lilkuzco.hirelings.command;

import com.mojang.brigadier.CommandDispatcher;
import dev.lilkuzco.hirelings.entity.WorkerEntities;
import dev.lilkuzco.hirelings.entity.WorkerEntity;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

public final class HirelingsCommands {
	private static final AABB WHOLE_WORLD = new AABB(-3.0E7, -512, -3.0E7, 3.0E7, 512, 3.0E7);

	public static void init() {
		CommandRegistrationCallback.EVENT.register((dispatcher, context, environment) -> register(dispatcher));
	}

	private static void register(CommandDispatcher<CommandSourceStack> dispatcher) {
		dispatcher.register(Commands.literal("hirelings")
				.then(Commands.literal("status").executes(ctx -> status(ctx.getSource())))
				.then(Commands.literal("recall").executes(ctx -> recall(ctx.getSource())))
				.then(Commands.literal("summon")
						.requires(Commands.hasPermission(Commands.LEVEL_GAMEMASTERS))
						.executes(ctx -> summon(ctx.getSource()))));
	}

	private static List<WorkerEntity> ownedWorkers(ServerPlayer player) {
		return player.level().getEntitiesOfClass(WorkerEntity.class, WHOLE_WORLD,
				worker -> worker.isOwnedBy(player));
	}

	private static int status(CommandSourceStack source) throws com.mojang.brigadier.exceptions.CommandSyntaxException {
		ServerPlayer player = source.getPlayerOrException();
		List<WorkerEntity> workers = ownedWorkers(player);
		source.sendSuccess(() -> Component.translatable("command.hirelings.status", workers.size()), false);
		for (WorkerEntity worker : workers) {
			source.sendSuccess(() -> Component.translatable("command.hirelings.status_line",
					worker.getDisplayName(), worker.getJob().id(), worker.getInventoryItemCount(),
					worker.blockPosition().toShortString()), false);
		}
		return workers.size();
	}

	private static int recall(CommandSourceStack source) throws com.mojang.brigadier.exceptions.CommandSyntaxException {
		ServerPlayer player = source.getPlayerOrException();
		List<WorkerEntity> workers = ownedWorkers(player);
		for (int i = 0; i < workers.size(); i++) {
			WorkerEntity worker = workers.get(i);
			Vec3 destination = recallDestination(player, worker, i);
			worker.teleportTo(destination.x, destination.y, destination.z);
			worker.setHomePos(worker.blockPosition());
		}
		source.sendSuccess(() -> Component.translatable("command.hirelings.recalled", workers.size()), false);
		return workers.size();
	}

	private static Vec3 recallDestination(ServerPlayer player, WorkerEntity worker, int index) {
		ServerLevel level = player.level();
		for (int attempt = 0; attempt < 16; attempt++) {
			int slot = index + attempt;
			double angle = slot * (Math.PI * 2.0 / 8.0);
			double radius = 1.5 + (slot / 8) * 1.5;
			double x = player.getX() + Math.cos(angle) * radius;
			double y = player.getY();
			double z = player.getZ() + Math.sin(angle) * radius;
			BlockPos floor = BlockPos.containing(x, y - 0.01, z);
			if (level.getBlockState(floor).getCollisionShape(level, floor).isEmpty()) {
				continue;
			}
			AABB movedBox = worker.getBoundingBox().move(x - worker.getX(), y - worker.getY(), z - worker.getZ());
			if (level.noCollision(worker, movedBox)) {
				return new Vec3(x, y, z);
			}
		}
		return player.position();
	}

	private static int summon(CommandSourceStack source) {
		ServerLevel level = source.getLevel();
		WorkerEntity worker = WorkerEntities.WORKER.create(level, EntitySpawnReason.COMMAND);
		if (worker == null) {
			return 0;
		}
		worker.snapTo(source.getPosition().x, source.getPosition().y, source.getPosition().z, 0.0F, 0.0F);
		worker.setPersistenceRequired();
		level.addFreshEntity(worker);
		source.sendSuccess(() -> Component.translatable("command.hirelings.summoned"), false);
		return 1;
	}

	private HirelingsCommands() {
	}
}
