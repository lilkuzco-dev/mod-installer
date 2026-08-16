package dev.lilkuzco.hirelings.entity;

import dev.lilkuzco.hirelings.entity.ai.FarmGoal;
import dev.lilkuzco.hirelings.entity.ai.FishGoal;
import dev.lilkuzco.hirelings.entity.ai.FollowEmployerGoal;
import dev.lilkuzco.hirelings.entity.ai.MineGoal;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.core.NonNullList;
import net.minecraft.network.chat.Component;
import net.minecraft.network.syncher.EntityDataAccessor;
import net.minecraft.network.syncher.EntityDataSerializers;
import net.minecraft.network.syncher.SynchedEntityData;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.BlockTags;
import net.minecraft.util.RandomSource;
import net.minecraft.world.ContainerHelper;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.PathfinderMob;
import net.minecraft.world.entity.ai.attributes.AttributeSupplier;
import net.minecraft.world.entity.ai.attributes.Attributes;
import net.minecraft.world.entity.ai.goal.FloatGoal;
import net.minecraft.world.entity.ai.goal.LookAtPlayerGoal;
import net.minecraft.world.entity.ai.goal.MeleeAttackGoal;
import net.minecraft.world.entity.ai.goal.RandomLookAroundGoal;
import net.minecraft.world.entity.ai.goal.WaterAvoidingRandomStrollGoal;
import net.minecraft.world.entity.ai.goal.target.HurtByTargetGoal;
import net.minecraft.world.entity.ai.goal.target.NearestAttackableTargetGoal;
import net.minecraft.world.entity.animal.Animal;
import net.minecraft.world.entity.animal.chicken.Chicken;
import net.minecraft.world.entity.animal.cow.Cow;
import net.minecraft.world.entity.animal.pig.Pig;
import net.minecraft.world.entity.animal.rabbit.Rabbit;
import net.minecraft.world.entity.animal.sheep.Sheep;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.Monster;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.LevelAccessor;
import net.minecraft.world.level.storage.ValueInput;
import net.minecraft.world.level.storage.ValueOutput;
import org.jspecify.annotations.Nullable;

/**
 * One persistent worker type. Ownership, job, work origin, and carried inventory are
 * data on the entity; job goals are small independent modules selected at runtime.
 */
public class WorkerEntity extends PathfinderMob {
	public static final int HIRE_COST = 8;
	public static final int INVENTORY_SIZE = 18;
	public static final int WORK_RADIUS = 16;

	private static final EntityDataAccessor<String> JOB =
			SynchedEntityData.defineId(WorkerEntity.class, EntityDataSerializers.STRING);

	private @Nullable UUID ownerUuid;
	private @Nullable BlockPos homePos;
	private NonNullList<ItemStack> inventory = NonNullList.withSize(INVENTORY_SIZE, ItemStack.EMPTY);
	private boolean inventoryDropped;

	public WorkerEntity(EntityType<? extends WorkerEntity> type, Level level) {
		super(type, level);
		setCanPickUpLoot(false); // collection is routed through the private worker inventory
	}

	public static AttributeSupplier.Builder createAttributes() {
		return Mob.createMobAttributes()
				.add(Attributes.MAX_HEALTH, 24.0)
				.add(Attributes.MOVEMENT_SPEED, 0.32)
				.add(Attributes.ATTACK_DAMAGE, 4.0)
				.add(Attributes.FOLLOW_RANGE, 24.0);
	}

	public static boolean checkSpawnRules(EntityType<? extends Mob> type, LevelAccessor level,
			EntitySpawnReason reason, BlockPos pos, RandomSource random) {
		return level.getBlockState(pos.below()).is(BlockTags.ANIMALS_SPAWNABLE_ON)
				&& level.getRawBrightness(pos, 0) > 8;
	}

	@Override
	protected void defineSynchedData(SynchedEntityData.Builder builder) {
		super.defineSynchedData(builder);
		builder.define(JOB, WorkerJob.IDLE.id());
	}

	@Override
	protected void registerGoals() {
		goalSelector.addGoal(0, new FloatGoal(this));
		goalSelector.addGoal(1, new MeleeAttackGoal(this, 1.15, true));
		goalSelector.addGoal(2, new FollowEmployerGoal(this, 1.1));
		goalSelector.addGoal(3, new MineGoal(this));
		goalSelector.addGoal(3, new FarmGoal(this));
		goalSelector.addGoal(3, new FishGoal(this));
		goalSelector.addGoal(7, new WaterAvoidingRandomStrollGoal(this, 0.7) {
			@Override
			public boolean canUse() {
				return (!isHired() || getJob() == WorkerJob.IDLE) && super.canUse();
			}
		});
		goalSelector.addGoal(8, new LookAtPlayerGoal(this, Player.class, 8.0F));
		goalSelector.addGoal(9, new RandomLookAroundGoal(this));

		targetSelector.addGoal(1, new HurtByTargetGoal(this) {
			@Override
			public boolean canUse() {
				return getLastHurtByMob() != null && !isFriendly(getLastHurtByMob()) && super.canUse();
			}
		});
		targetSelector.addGoal(2, new NearestAttackableTargetGoal<>(this, Monster.class, true,
				(target, level) -> isHired() && getJob() == WorkerJob.HUNTER
						&& isWithinWorkArea(target.blockPosition())));
		targetSelector.addGoal(3, new NearestAttackableTargetGoal<>(this, Animal.class, true,
				(target, level) -> isHired() && getJob() == WorkerJob.HUNTER
						&& isWithinWorkArea(target.blockPosition())
						&& target instanceof Animal animal && !animal.isBaby() && isHuntableAnimal(animal)));
	}

	private static boolean isHuntableAnimal(Animal animal) {
		return animal instanceof Chicken || animal instanceof Cow || animal instanceof Pig
				|| animal instanceof Rabbit || animal instanceof Sheep;
	}

	@Override
	protected void customServerAiStep(ServerLevel level) {
		super.customServerAiStep(level);
		if (getTarget() != null && getLastHurtByMob() != getTarget()
				&& (getJob() != WorkerJob.HUNTER || !isWithinWorkArea(getTarget().blockPosition()))) {
			setTarget(null);
		}
		if (isHired() && tickCount % 10 == 0) {
			collectNearbyDrops(level);
		}
	}

	private void collectNearbyDrops(ServerLevel level) {
		for (ItemEntity item : level.getEntitiesOfClass(ItemEntity.class, getBoundingBox().inflate(2.0),
				ItemEntity::isAlive)) {
			ItemStack remainder = store(item.getItem().copy());
			if (remainder.isEmpty()) {
				item.discard();
			} else {
				item.setItem(remainder);
			}
		}
	}

	// ---------- ownership and assignment ----------
	public boolean isHired() {
		return ownerUuid != null;
	}

	public boolean isOwnedBy(Player player) {
		return ownerUuid != null && ownerUuid.equals(player.getUUID());
	}

	private boolean isFriendly(Entity entity) {
		if (ownerUuid == null) return false;
		return entity instanceof Player player && ownerUuid.equals(player.getUUID())
				|| entity instanceof WorkerEntity worker && ownerUuid.equals(worker.ownerUuid);
	}

	public @Nullable ServerPlayer getEmployer() {
		if (ownerUuid == null || !(level() instanceof ServerLevel serverLevel)) {
			return null;
		}
		return serverLevel.getServer().getPlayerList().getPlayer(ownerUuid);
	}

	public WorkerJob getJob() {
		return WorkerJob.byId(entityData.get(JOB));
	}

	public void setJob(WorkerJob job) {
		entityData.set(JOB, job.id());
		setTarget(null);
		getNavigation().stop();
		setItemSlot(net.minecraft.world.entity.EquipmentSlot.MAINHAND, switch (job) {
			case MINER -> new ItemStack(Items.IRON_PICKAXE);
			case FARMER -> new ItemStack(Items.IRON_HOE);
			case FISHER -> new ItemStack(Items.FISHING_ROD);
			case HUNTER -> new ItemStack(Items.IRON_SWORD);
			case IDLE -> ItemStack.EMPTY;
		});
		setDropChance(net.minecraft.world.entity.EquipmentSlot.MAINHAND, 0.0F);
		if (job != WorkerJob.IDLE) {
			homePos = blockPosition();
		}
	}

	public @Nullable BlockPos getHomePos() {
		return homePos;
	}

	public void setHomePos(BlockPos pos) {
		homePos = pos.immutable();
	}

	public boolean isWithinWorkArea(BlockPos pos) {
		return homePos == null || homePos.closerThan(pos, WORK_RADIUS + 0.5);
	}

	@Override
	public boolean removeWhenFarAway(double distanceToClosestPlayer) {
		return !isHired() && super.removeWhenFarAway(distanceToClosestPlayer);
	}

	@Override
	protected InteractionResult mobInteract(Player player, InteractionHand hand) {
		ItemStack stack = player.getItemInHand(hand);
		if (!isHired()) {
			if (stack.is(Items.EMERALD) && stack.getCount() >= HIRE_COST) {
				if (!level().isClientSide()) {
					if (!player.isCreative()) {
						stack.shrink(HIRE_COST);
					}
					ownerUuid = player.getUUID();
					homePos = blockPosition();
					setPersistenceRequired();
					player.sendSystemMessage(Component.translatable("message.hirelings.hired", getDisplayName()));
					player.sendSystemMessage(Component.translatable("message.hirelings.hired_help"));
				}
				return InteractionResult.SUCCESS;
			}
			if (!level().isClientSide()) {
				player.sendSystemMessage(Component.translatable("message.hirelings.cost", HIRE_COST));
			}
			return InteractionResult.SUCCESS;
		}

		if (!isOwnedBy(player)) {
			if (!level().isClientSide()) {
				player.sendSystemMessage(Component.translatable("message.hirelings.not_owner"));
			}
			return InteractionResult.SUCCESS;
		}

		WorkerJob assignment = jobFor(stack);
		if (assignment != null) {
			if (!level().isClientSide()) {
				setJob(assignment);
				player.sendSystemMessage(Component.translatable("message.hirelings.assigned", assignment.id(),
						homePos == null ? "?" : homePos.toShortString()));
			}
			return InteractionResult.SUCCESS;
		}

		if (stack.isEmpty()) {
			if (!level().isClientSide()) {
				if (player.isSecondaryUseActive()) {
					int transferred = transferInventoryTo(player);
					player.sendSystemMessage(Component.translatable("message.hirelings.collected", transferred));
				} else {
					player.sendSystemMessage(Component.translatable("message.hirelings.status", getJob().id(),
							getInventoryItemCount(), homePos == null ? "unset" : homePos.toShortString()));
				}
			}
			return InteractionResult.SUCCESS;
		}
		return super.mobInteract(player, hand);
	}

	private static @Nullable WorkerJob jobFor(ItemStack stack) {
		if (isAny(stack, Items.WOODEN_PICKAXE, Items.STONE_PICKAXE, Items.IRON_PICKAXE,
				Items.GOLDEN_PICKAXE, Items.DIAMOND_PICKAXE, Items.NETHERITE_PICKAXE)) {
			return WorkerJob.MINER;
		}
		if (isAny(stack, Items.WOODEN_HOE, Items.STONE_HOE, Items.IRON_HOE,
				Items.GOLDEN_HOE, Items.DIAMOND_HOE, Items.NETHERITE_HOE)) {
			return WorkerJob.FARMER;
		}
		if (stack.is(Items.FISHING_ROD)) {
			return WorkerJob.FISHER;
		}
		if (isAny(stack, Items.WOODEN_SWORD, Items.STONE_SWORD, Items.IRON_SWORD,
				Items.GOLDEN_SWORD, Items.DIAMOND_SWORD, Items.NETHERITE_SWORD,
				Items.WOODEN_AXE, Items.STONE_AXE, Items.IRON_AXE, Items.GOLDEN_AXE,
				Items.DIAMOND_AXE, Items.NETHERITE_AXE, Items.BOW, Items.CROSSBOW)) {
			return WorkerJob.HUNTER;
		}
		if (stack.is(Items.CLOCK)) {
			return WorkerJob.IDLE;
		}
		return null;
	}

	private static boolean isAny(ItemStack stack, net.minecraft.world.item.Item... items) {
		for (net.minecraft.world.item.Item item : items) {
			if (stack.is(item)) {
				return true;
			}
		}
		return false;
	}

	// ---------- private carried inventory ----------
	public ItemStack store(ItemStack stack) {
		for (int i = 0; i < inventory.size() && !stack.isEmpty(); i++) {
			ItemStack existing = inventory.get(i);
			if (!existing.isEmpty() && ItemStack.isSameItemSameComponents(existing, stack)) {
				int moved = Math.min(existing.getMaxStackSize() - existing.getCount(), stack.getCount());
				existing.grow(moved);
				stack.shrink(moved);
			}
		}
		for (int i = 0; i < inventory.size() && !stack.isEmpty(); i++) {
			if (inventory.get(i).isEmpty()) {
				int moved = Math.min(stack.getCount(), stack.getMaxStackSize());
				inventory.set(i, stack.copyWithCount(moved));
				stack.shrink(moved);
			}
		}
		return stack;
	}

	public int getInventoryItemCount() {
		return inventory.stream().mapToInt(ItemStack::getCount).sum();
	}

	private int transferInventoryTo(Player player) {
		int transferred = 0;
		for (int i = 0; i < inventory.size(); i++) {
			ItemStack moving = inventory.get(i).copy();
			if (moving.isEmpty()) {
				continue;
			}
			transferred += moving.getCount();
			player.getInventory().add(moving);
			if (!moving.isEmpty()) {
				player.drop(moving, false);
			}
			inventory.set(i, ItemStack.EMPTY);
		}
		return transferred;
	}

	private void dropInventory() {
		if (inventoryDropped || level().isClientSide()) {
			return;
		}
		inventoryDropped = true;
		for (ItemStack stack : inventory) {
			if (!stack.isEmpty()) {
				net.minecraft.world.level.block.Block.popResource(level(), blockPosition(), stack.copy());
			}
		}
		inventory.clear();
	}

	@Override
	public void die(DamageSource source) {
		dropInventory();
		super.die(source);
	}

	// ---------- persistence ----------
	@Override
	protected void addAdditionalSaveData(ValueOutput output) {
		super.addAdditionalSaveData(output);
		output.putString("hirelings_owner", ownerUuid == null ? "" : ownerUuid.toString());
		output.putString("hirelings_job", getJob().id());
		output.storeNullable("hirelings_home", BlockPos.CODEC, homePos);
		ContainerHelper.saveAllItems(output, inventory);
	}

	@Override
	protected void readAdditionalSaveData(ValueInput input) {
		super.readAdditionalSaveData(input);
		String owner = input.getStringOr("hirelings_owner", "");
		try {
			ownerUuid = owner.isEmpty() ? null : UUID.fromString(owner);
		} catch (IllegalArgumentException ignored) {
			ownerUuid = null;
		}
		entityData.set(JOB, WorkerJob.byId(input.getStringOr("hirelings_job", "idle")).id());
		homePos = input.read("hirelings_home", BlockPos.CODEC).orElse(null);
		inventory = NonNullList.withSize(INVENTORY_SIZE, ItemStack.EMPTY);
		ContainerHelper.loadAllItems(input, inventory);
		if (isHired()) {
			setPersistenceRequired();
		}
	}
}
