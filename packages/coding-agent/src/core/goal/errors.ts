/** Account/provider usage limits that should stop automatic goal continuation. */
const GOAL_USAGE_LIMIT_ERROR_PATTERN =
	/GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;

export function isGoalUsageLimitError(errorMessage: string | undefined): boolean {
	return typeof errorMessage === "string" && GOAL_USAGE_LIMIT_ERROR_PATTERN.test(errorMessage);
}
