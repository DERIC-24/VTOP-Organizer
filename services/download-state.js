export const MATERIAL_STATES = Object.freeze({
    PENDING: "pending",
    DOWNLOADING: "downloading",
    RETRYING: "retrying",
    COMPLETED: "completed",
    FAILED: "failed",
    CANCELLED: "cancelled",
    SKIPPED: "skipped"
});

export const QUEUE_STATES = Object.freeze({
    IDLE: "idle",
    RUNNING: "running",
    PAUSED: "paused",
    CANCELLING: "cancelling",
    COMPLETED: "completed",
    COMPLETED_WITH_ERRORS: "completed_with_errors"
});

const VALID_MATERIAL_STATES = new Set(Object.values(MATERIAL_STATES));
const VALID_QUEUE_STATES = new Set(Object.values(QUEUE_STATES));

const TERMINAL_MATERIAL_STATES = new Set([
    MATERIAL_STATES.COMPLETED,
    MATERIAL_STATES.FAILED,
    MATERIAL_STATES.CANCELLED,
    MATERIAL_STATES.SKIPPED
]);

const TERMINAL_QUEUE_STATES = new Set([
    QUEUE_STATES.COMPLETED,
    QUEUE_STATES.COMPLETED_WITH_ERRORS
]);

const MATERIAL_TRANSITIONS = Object.freeze({
    [MATERIAL_STATES.PENDING]: new Set([
        MATERIAL_STATES.DOWNLOADING,
        MATERIAL_STATES.SKIPPED,
        MATERIAL_STATES.CANCELLED
    ]),
    [MATERIAL_STATES.DOWNLOADING]: new Set([
        MATERIAL_STATES.PENDING,
        MATERIAL_STATES.COMPLETED,
        MATERIAL_STATES.RETRYING,
        MATERIAL_STATES.FAILED,
        MATERIAL_STATES.CANCELLED
    ]),
    [MATERIAL_STATES.RETRYING]: new Set([
        MATERIAL_STATES.PENDING,
        MATERIAL_STATES.DOWNLOADING,
        MATERIAL_STATES.FAILED,
        MATERIAL_STATES.CANCELLED
    ]),
    [MATERIAL_STATES.COMPLETED]: new Set(),
    [MATERIAL_STATES.FAILED]: new Set(),
    [MATERIAL_STATES.CANCELLED]: new Set(),
    [MATERIAL_STATES.SKIPPED]: new Set()
});

const QUEUE_TRANSITIONS = Object.freeze({
    [QUEUE_STATES.IDLE]: new Set([
        QUEUE_STATES.RUNNING
    ]),
    [QUEUE_STATES.RUNNING]: new Set([
        QUEUE_STATES.PAUSED,
        QUEUE_STATES.CANCELLING,
        QUEUE_STATES.COMPLETED,
        QUEUE_STATES.COMPLETED_WITH_ERRORS
    ]),
    [QUEUE_STATES.PAUSED]: new Set([
        QUEUE_STATES.RUNNING,
        QUEUE_STATES.CANCELLING,
        QUEUE_STATES.COMPLETED_WITH_ERRORS
    ]),
    [QUEUE_STATES.CANCELLING]: new Set([
        QUEUE_STATES.COMPLETED,
        QUEUE_STATES.COMPLETED_WITH_ERRORS
    ]),
    [QUEUE_STATES.COMPLETED]: new Set(),
    [QUEUE_STATES.COMPLETED_WITH_ERRORS]: new Set()
});

export class InvalidStateTransitionError extends Error {
    constructor(entity, fromState, toState) {
        super(`Invalid ${entity} state transition: "${fromState}" -> "${toState}".`);
        this.name = "InvalidStateTransitionError";
        this.entity = entity;
        this.fromState = fromState;
        this.toState = toState;
    }
}

export function isValidMaterialState(state) {
    return VALID_MATERIAL_STATES.has(state);
}

export function isValidQueueState(state) {
    return VALID_QUEUE_STATES.has(state);
}

export function isTerminalMaterialState(state) {
    return TERMINAL_MATERIAL_STATES.has(state);
}

export function isTerminalQueueState(state) {
    return TERMINAL_QUEUE_STATES.has(state);
}

export function canTransitionMaterialState(fromState, toState) {
    if (!isValidMaterialState(fromState) || !isValidMaterialState(toState)) {
        return false;
    }
    return MATERIAL_TRANSITIONS[fromState].has(toState);
}

export function transitionMaterialState(fromState, toState) {
    if (!canTransitionMaterialState(fromState, toState)) {
        throw new InvalidStateTransitionError("material", fromState, toState);
    }
    return toState;
}

export function canTransitionQueueState(fromState, toState) {
    if (!isValidQueueState(fromState) || !isValidQueueState(toState)) {
        return false;
    }
    return QUEUE_TRANSITIONS[fromState].has(toState);
}

export function transitionQueueState(fromState, toState) {
    if (!canTransitionQueueState(fromState, toState)) {
        throw new InvalidStateTransitionError("queue", fromState, toState);
    }
    return toState;
}

export function computeFinalQueueState(items) {
    if (!Array.isArray(items) || items.length === 0) {
        throw new Error("Cannot compute final queue state for an empty item list.");
    }
    const hasUnfinishedOrFailed = items.some(
        (item) =>
            item.state !== MATERIAL_STATES.COMPLETED &&
            item.state !== MATERIAL_STATES.SKIPPED
    );
    return hasUnfinishedOrFailed
        ? QUEUE_STATES.COMPLETED_WITH_ERRORS
        : QUEUE_STATES.COMPLETED;
}
