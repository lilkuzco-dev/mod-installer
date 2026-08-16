package dev.lilkuzco.hirelings.entity.ai;

import dev.lilkuzco.hirelings.Hirelings;
import dev.lilkuzco.hirelings.entity.WorkerEntity;
import dev.lilkuzco.hirelings.entity.WorkerJob;
import java.util.EnumSet;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.Registries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.TagKey;
import net.minecraft.world.entity.ai.goal.Goal;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.gamerules.GameRules;
import org.jspecify.annotations.Nullable;

/** Finds tagged ore in the worker's bounded work area, paths to it, and stores normal drops. */
public class MineGoal extends Goal {
	public static final TagKey<Block> WORKER_MINEABLE = TagKey.create(Registries.BLOCK, Hirelings.id("worker_mineable"));

	private final WorkerEntity worker;
	private @Nullable BlockPos target;
	private int breakTicks;
	private int nextSearch;
	private int travelTicks;
	private @Nullable BlockPos failedTarget;
	private int failedTargetRetryTick;

	public MineGoal(WorkerEntity worker) {
		this.worker = worker;
		setFlags(EnumSet.of(Goal.Flag.MOVE, Goal.Flag.LOOK));
	}

	@Override
	public boolean canUse() {
		if (!worker.isHired() || worker.getJob() != WorkerJob.MINER || worker.getTarget() != null
				|| --nextSearch > 0 || !(worker.level() instanceof ServerLevel level)
				|| !level.getGameRules().get(GameRules.MOB_GRIEFING)) {
			return false;
		}
		nextSearch = adjustedTickDelay(60);
		target = findTarget(level);
		return target != null;
	}

	private @Nullable BlockPos findTarget(ServerLevel level) {
		BlockPos center = worker.getHomePos() == null ? worker.blockPosition() : worker.getHomePos();
		BlockPos best = null;
		double bestDistance = Double.MAX_VALUE;
		for (BlockPos pos : BlockPos.betweenClosed(center.offset(-WorkerEntity.WORK_RADIUS, -8, -WorkerEntity.WORK_RADIUS),
				center.offset(WorkerEntity.WORK_RADIUS, 8, WorkerEntity.WORK_RADIUS))) {
			if (!worker.isWithinWorkArea(pos) || !hasChunk(level, pos)) {
				continue;
			}
			BlockState state = level.getBlockState(pos);
			if (!state.is(WORKER_MINEABLE) || state.getDestroySpeed(level, pos) < 0
					|| level.getBlockEntity(pos) != null || !isExposed(level, pos)
					|| pos.equals(failedTarget) && worker.tickCount < failedTargetRetryTick) {
				continue;
			}
			double distance = pos.distToCenterSqr(worker.position());
			if (distance < bestDistance) {
				bestDistance = distance;
				best = pos.immutable();
			}
		}
		return best;
	}

	private static boolean isExposed(ServerLevel level, BlockPos pos) {
		for (net.minecraft.core.Direction direction : net.minecraft.core.Direction.values()) {
			BlockPos beside = pos.relative(direction);
			if (hasChunk(level, beside)
					&& level.getBlockState(beside).getCollisionShape(level, beside).isEmpty()) {
				return true;
			}
		}
		return false;
	}

	private static boolean hasChunk(ServerLevel level, BlockPos pos) {
		return level.hasChunk(pos.getX() >> 4, pos.getZ() >> 4);
	}

	@Override
	public boolean canContinueToUse() {
		return target != null && worker.getJob() == WorkerJob.MINER && worker.isWithinWorkArea(target)
				&& worker.level() instanceof ServerLevel level
				&& level.getGameRules().get(GameRules.MOB_GRIEFING)
				&& level.getBlockState(target).is(WORKER_MINEABLE);
	}

	@Override
	public void start() {
		breakTicks = 0;
		travelTicks = 0;
		moveToTarget();
	}

	@Override
	public void tick() {
		if (target == null || !(worker.level() instanceof ServerLevel level)) {
			return;
		}
		worker.getLookControl().setLookAt(target.getX() + 0.5, target.getY() + 0.5, target.getZ() + 0.5);
		if (target.distToCenterSqr(worker.position()) > 3.0 * 3.0) {
			if (++travelTicks > adjustedTickDelay(240)) {
				failedTarget = target;
				failedTargetRetryTick = worker.tickCount + adjustedTickDelay(600);
				target = null;
				return;
			}
			if (worker.getNavigation().isDone() || worker.tickCount % 30 == 0) {
				moveToTarget();
			}
			return;
		}
		worker.getNavigation().stop();
		BlockState state = level.getBlockState(target);
		int required = Math.max(20, Math.round(state.getDestroySpeed(level, target) * 30.0F));
		if (++breakTicks < required) {
			return;
		}
		List<ItemStack> drops = Block.getDrops(state, level, target, level.getBlockEntity(target), worker,
				new ItemStack(Items.IRON_PICKAXE));
		level.destroyBlock(target, false, worker);
		for (ItemStack drop : drops) {
			ItemStack remainder = worker.store(drop.copy());
			if (!remainder.isEmpty()) {
				Block.popResource(level, worker.blockPosition(), remainder);
			}
		}
		failedTarget = null;
		target = null;
		nextSearch = adjustedTickDelay(30);
	}

	private void moveToTarget() {
		if (target != null) {
			worker.getNavigation().moveTo(target.getX() + 0.5, target.getY(), target.getZ() + 0.5, 1.0);
		}
	}

	@Override
	public void stop() {
		target = null;
		breakTicks = 0;
		travelTicks = 0;
		worker.getNavigation().stop();
	}
}
