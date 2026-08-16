package dev.lilkuzco.hirelings.entity.ai;

import dev.lilkuzco.hirelings.entity.WorkerEntity;
import dev.lilkuzco.hirelings.entity.WorkerJob;
import java.util.EnumSet;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.sounds.SoundEvents;
import net.minecraft.sounds.SoundSource;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.entity.ai.goal.Goal;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Block;
import org.jspecify.annotations.Nullable;

/** A lightweight server-side fishing loop: reach a shoreline, wait, then add a catch. */
public class FishGoal extends Goal {
	private final WorkerEntity worker;
	private @Nullable BlockPos water;
	private @Nullable BlockPos stand;
	private int fishingTicks;
	private int nextSearch;
	private int travelTicks;
	private @Nullable BlockPos failedStand;
	private int failedStandRetryTick;

	public FishGoal(WorkerEntity worker) {
		this.worker = worker;
		setFlags(EnumSet.of(Goal.Flag.MOVE, Goal.Flag.LOOK));
	}

	@Override
	public boolean canUse() {
		if (!worker.isHired() || worker.getJob() != WorkerJob.FISHER || worker.getTarget() != null
				|| --nextSearch > 0 || !(worker.level() instanceof ServerLevel level)) {
			return false;
		}
		nextSearch = adjustedTickDelay(80);
		findShore(level);
		return water != null && stand != null;
	}

	private void findShore(ServerLevel level) {
		water = null;
		stand = null;
		BlockPos center = worker.getHomePos() == null ? worker.blockPosition() : worker.getHomePos();
		double bestDistance = Double.MAX_VALUE;
		for (BlockPos pos : BlockPos.betweenClosed(center.offset(-10, -3, -10), center.offset(10, 3, 10))) {
			if (!hasChunk(level, pos) || !level.getFluidState(pos).is(FluidTags.WATER)
					|| level.getFluidState(pos.above()).is(FluidTags.WATER)) {
				continue;
			}
			for (net.minecraft.core.Direction direction : net.minecraft.core.Direction.Plane.HORIZONTAL) {
				BlockPos beside = pos.relative(direction);
				for (BlockPos candidate : new BlockPos[] {beside, beside.above()}) {
					double distance = candidate.distToCenterSqr(worker.position());
					if (hasChunk(level, candidate) && level.getBlockState(candidate).isAir()
							&& level.getBlockState(candidate.above()).isAir()
							&& !level.getBlockState(candidate.below())
									.getCollisionShape(level, candidate.below()).isEmpty()
							&& !(candidate.equals(failedStand) && worker.tickCount < failedStandRetryTick)
							&& distance < bestDistance) {
						water = pos.immutable();
						stand = candidate.immutable();
						bestDistance = distance;
					}
				}
			}
		}
	}

	private static boolean hasChunk(ServerLevel level, BlockPos pos) {
		return level.hasChunk(pos.getX() >> 4, pos.getZ() >> 4);
	}

	@Override
	public boolean canContinueToUse() {
		return water != null && stand != null && worker.getJob() == WorkerJob.FISHER && fishingTicks > 0
				&& worker.level().getFluidState(water).is(FluidTags.WATER);
	}

	@Override
	public void start() {
		fishingTicks = 180 + worker.getRandom().nextInt(161);
		travelTicks = 0;
		moveToShore();
	}

	@Override
	public void tick() {
		if (water == null || stand == null || !(worker.level() instanceof ServerLevel level)) {
			return;
		}
		if (stand.distToCenterSqr(worker.position()) > 2.5 * 2.5) {
			if (++travelTicks > adjustedTickDelay(240)) {
				failedStand = stand;
				failedStandRetryTick = worker.tickCount + adjustedTickDelay(600);
				water = null;
				stand = null;
				return;
			}
			if (worker.getNavigation().isDone() || worker.tickCount % 30 == 0) {
				moveToShore();
			}
			return;
		}
		worker.getNavigation().stop();
		worker.getLookControl().setLookAt(water.getX() + 0.5, water.getY() + 0.2, water.getZ() + 0.5);
		if (--fishingTicks > 0) {
			return;
		}
		ItemStack catchStack = new ItemStack(rollCatch());
		ItemStack remainder = worker.store(catchStack);
		if (!remainder.isEmpty()) {
			Block.popResource(level, worker.blockPosition(), remainder);
		}
		level.playSound(null, water, SoundEvents.FISHING_BOBBER_SPLASH, SoundSource.NEUTRAL, 0.8F, 1.0F);
		water = null;
		stand = null;
		failedStand = null;
		nextSearch = adjustedTickDelay(100);
	}

	private net.minecraft.world.item.Item rollCatch() {
		int roll = worker.getRandom().nextInt(100);
		if (roll < 55) return Items.COD;
		if (roll < 85) return Items.SALMON;
		if (roll < 95) return Items.TROPICAL_FISH;
		return Items.PUFFERFISH;
	}

	private void moveToShore() {
		if (stand != null) {
			worker.getNavigation().moveTo(stand.getX() + 0.5, stand.getY(), stand.getZ() + 0.5, 0.9);
		}
	}

	@Override
	public void stop() {
		water = null;
		stand = null;
		fishingTicks = 0;
		travelTicks = 0;
		worker.getNavigation().stop();
	}
}
