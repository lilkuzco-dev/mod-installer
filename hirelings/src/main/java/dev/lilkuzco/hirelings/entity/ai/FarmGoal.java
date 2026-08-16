package dev.lilkuzco.hirelings.entity.ai;

import dev.lilkuzco.hirelings.entity.WorkerEntity;
import dev.lilkuzco.hirelings.entity.WorkerJob;
import java.util.EnumSet;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.ai.goal.Goal;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.CropBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.gamerules.GameRules;
import org.jspecify.annotations.Nullable;

/** Harvests mature vanilla crops and immediately replants them at age zero. */
public class FarmGoal extends Goal {
	private final WorkerEntity worker;
	private @Nullable BlockPos cropPos;
	private int nextSearch;
	private int travelTicks;
	private @Nullable BlockPos failedCrop;
	private int failedCropRetryTick;

	public FarmGoal(WorkerEntity worker) {
		this.worker = worker;
		setFlags(EnumSet.of(Goal.Flag.MOVE, Goal.Flag.LOOK));
	}

	@Override
	public boolean canUse() {
		if (!worker.isHired() || worker.getJob() != WorkerJob.FARMER || worker.getTarget() != null
				|| --nextSearch > 0 || !(worker.level() instanceof ServerLevel level)
				|| !level.getGameRules().get(GameRules.MOB_GRIEFING)) {
			return false;
		}
		nextSearch = adjustedTickDelay(40);
		cropPos = findMatureCrop(level);
		return cropPos != null;
	}

	private @Nullable BlockPos findMatureCrop(ServerLevel level) {
		BlockPos center = worker.getHomePos() == null ? worker.blockPosition() : worker.getHomePos();
		BlockPos best = null;
		double bestDistance = Double.MAX_VALUE;
		for (BlockPos pos : BlockPos.betweenClosed(center.offset(-WorkerEntity.WORK_RADIUS, -3, -WorkerEntity.WORK_RADIUS),
				center.offset(WorkerEntity.WORK_RADIUS, 3, WorkerEntity.WORK_RADIUS))) {
			if (!level.hasChunk(pos.getX() >> 4, pos.getZ() >> 4)) {
				continue;
			}
			BlockState state = level.getBlockState(pos);
			if (!(state.getBlock() instanceof CropBlock crop) || !crop.isMaxAge(state)
					|| pos.equals(failedCrop) && worker.tickCount < failedCropRetryTick) {
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

	@Override
	public boolean canContinueToUse() {
		if (cropPos == null || worker.getJob() != WorkerJob.FARMER
				|| !worker.isWithinWorkArea(cropPos)
				|| !(worker.level() instanceof ServerLevel level)
				|| !level.getGameRules().get(GameRules.MOB_GRIEFING)) {
			return false;
		}
		BlockState state = worker.level().getBlockState(cropPos);
		return state.getBlock() instanceof CropBlock crop && crop.isMaxAge(state);
	}

	@Override
	public void start() {
		travelTicks = 0;
		moveToCrop();
	}

	@Override
	public void tick() {
		if (cropPos == null || !(worker.level() instanceof ServerLevel level)) {
			return;
		}
		worker.getLookControl().setLookAt(cropPos.getX() + 0.5, cropPos.getY() + 0.5, cropPos.getZ() + 0.5);
		if (cropPos.distToCenterSqr(worker.position()) > 2.5 * 2.5) {
			if (++travelTicks > adjustedTickDelay(200)) {
				failedCrop = cropPos;
				failedCropRetryTick = worker.tickCount + adjustedTickDelay(600);
				cropPos = null;
				return;
			}
			if (worker.getNavigation().isDone() || worker.tickCount % 30 == 0) {
				moveToCrop();
			}
			return;
		}
		BlockState state = level.getBlockState(cropPos);
		if (!(state.getBlock() instanceof CropBlock crop) || !crop.isMaxAge(state)) {
			cropPos = null;
			return;
		}
		List<ItemStack> drops = Block.getDrops(state, level, cropPos, level.getBlockEntity(cropPos), worker,
				new ItemStack(Items.IRON_HOE));
		consumeReplantSeed(drops, seedFor(state));
		level.setBlockAndUpdate(cropPos, crop.getStateForAge(0));
		for (ItemStack drop : drops) {
			ItemStack remainder = worker.store(drop.copy());
			if (!remainder.isEmpty()) {
				Block.popResource(level, worker.blockPosition(), remainder);
			}
		}
		failedCrop = null;
		cropPos = null;
		nextSearch = adjustedTickDelay(20);
	}

	private static @Nullable Item seedFor(BlockState state) {
		if (state.is(Blocks.WHEAT)) return Items.WHEAT_SEEDS;
		if (state.is(Blocks.BEETROOTS)) return Items.BEETROOT_SEEDS;
		if (state.is(Blocks.CARROTS)) return Items.CARROT;
		if (state.is(Blocks.POTATOES)) return Items.POTATO;
		return null;
	}

	private static void consumeReplantSeed(List<ItemStack> drops, @Nullable Item seed) {
		if (seed == null) {
			return;
		}
		for (ItemStack stack : drops) {
			if (stack.is(seed) && !stack.isEmpty()) {
				stack.shrink(1);
				return;
			}
		}
	}

	private void moveToCrop() {
		if (cropPos != null) {
			worker.getNavigation().moveTo(cropPos.getX() + 0.5, cropPos.getY(), cropPos.getZ() + 0.5, 0.9);
		}
	}

	@Override
	public void stop() {
		cropPos = null;
		travelTicks = 0;
		worker.getNavigation().stop();
	}
}
