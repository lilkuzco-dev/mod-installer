package dev.lilkuzco.hirelings.entity;

public enum WorkerJob {
	IDLE("idle"),
	MINER("miner"),
	FARMER("farmer"),
	FISHER("fisher"),
	HUNTER("hunter");

	private final String id;

	WorkerJob(String id) {
		this.id = id;
	}

	public String id() {
		return id;
	}

	public static WorkerJob byId(String id) {
		for (WorkerJob job : values()) {
			if (job.id.equals(id)) {
				return job;
			}
		}
		return IDLE;
	}
}
