package dev.lilkuzco.hirelings.entity.ai;

import dev.lilkuzco.hirelings.entity.WorkerEntity;
import dev.lilkuzco.hirelings.entity.WorkerJob;
import java.util.EnumSet;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.ai.goal.Goal;

/** Idle workers follow normally; assigned workers only break off work when stranded far away. */
public class FollowEmployerGoal extends Goal {
	private final WorkerEntity worker;
	private final double speed;
	private ServerPlayer employer;

	public FollowEmployerGoal(WorkerEntity worker, double speed) {
		this.worker = worker;
		this.speed = speed;
		setFlags(EnumSet.of(Goal.Flag.MOVE, Goal.Flag.LOOK));
	}

	@Override
	public boolean canUse() {
		employer = worker.getEmployer();
		if (employer == null || employer.level() != worker.level() || employer.isSpectator()) {
			return false;
		}
		return worker.getJob() == WorkerJob.IDLE && worker.distanceToSqr(employer) > 6.0 * 6.0;
	}

	@Override
	public boolean canContinueToUse() {
		return worker.getJob() == WorkerJob.IDLE && employer != null && employer.isAlive()
				&& employer.level() == worker.level()
				&& worker.distanceToSqr(employer) > 3.0 * 3.0;
	}

	@Override
	public void tick() {
		if (employer == null) {
			return;
		}
		worker.getLookControl().setLookAt(employer, 10.0F, worker.getMaxHeadXRot());
		if (worker.tickCount % 10 == 0) {
			worker.getNavigation().moveTo(employer, speed);
		}
	}

	@Override
	public void stop() {
		employer = null;
		worker.getNavigation().stop();
	}
}
