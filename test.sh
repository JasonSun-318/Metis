#!/usr/bin/env bash
set -e

# fd and rg are invoked by unit tests. Linux also invokes the trash CLI;
# macOS moves files with osascript and does not require it. Fail before npm so
# a missing binary is an install hint instead of a later command-not-found
# failure. Debian/Ubuntu ship fd as fdfind; tests look up the fd command by name.
missing=""
if ! command -v fd >/dev/null 2>&1; then
    missing="fd"
fi
if ! command -v rg >/dev/null 2>&1; then
    missing="${missing:+$missing, }rg"
fi
if [ "$(/usr/bin/uname -s 2>/dev/null || true)" = "Linux" ] && ! command -v trash >/dev/null 2>&1; then
    missing="${missing:+$missing, }trash"
fi
if [ -n "$missing" ]; then
    echo "Missing test tools: ${missing}." >&2
    if [ "$(/usr/bin/uname -s 2>/dev/null || true)" = "Linux" ]; then
        echo "Unit tests need fd, rg (ripgrep), and trash on PATH." >&2
    else
        echo "Unit tests need fd and rg (ripgrep) on PATH." >&2
    fi
    echo 'Debian/Ubuntu: sudo apt-get install -y fd-find ripgrep trash-cli && sudo ln -sfn "$(command -v fdfind)" /usr/local/bin/fd' >&2
    echo 'macOS: brew install fd ripgrep' >&2
    exit 1
fi

testAgentDir="$(mktemp -d "${TMPDIR:-/tmp}/metis-tests.XXXXXXXX")"
export METIS_CODING_AGENT_DIR="$testAgentDir"
unset METIS_CODING_AGENT_SESSION_DIR

# Keep test configuration separate from the user's credentials and sessions.
cleanup() {
    rm -rf "$testAgentDir"
}
trap cleanup EXIT

# Skip local LLM tests (ollama, lmstudio)
export METIS_NO_LOCAL_LLM=1

# Unset API keys (see packages/ai/src/env-api-keys.ts getEnvApiKey)
unset ANTHROPIC_API_KEY
unset ANT_LING_API_KEY
unset NVIDIA_API_KEY
unset OPENAI_API_KEY
unset AZURE_OPENAI_API_KEY
unset DEEPSEEK_API_KEY
unset GEMINI_API_KEY
unset GOOGLE_CLOUD_API_KEY
unset GROQ_API_KEY
unset CEREBRAS_API_KEY
unset XAI_API_KEY
unset OPENROUTER_API_KEY
unset ZAI_API_KEY
unset ZAI_CODING_CN_API_KEY
unset MISTRAL_API_KEY
unset MINIMAX_API_KEY
unset MINIMAX_CN_API_KEY
unset MOONSHOT_API_KEY
unset KIMI_API_KEY
unset HF_TOKEN
unset FIREWORKS_API_KEY
unset TOGETHER_API_KEY
unset AI_GATEWAY_API_KEY
unset OPENCODE_API_KEY
unset CLOUDFLARE_API_KEY
unset CLOUDFLARE_ACCOUNT_ID
unset CLOUDFLARE_GATEWAY_ID
unset XIAOMI_API_KEY
unset XIAOMI_TOKEN_PLAN_CN_API_KEY
unset XIAOMI_TOKEN_PLAN_AMS_API_KEY
unset XIAOMI_TOKEN_PLAN_SGP_API_KEY
unset QWEN_TOKEN_PLAN_API_KEY
unset QWEN_TOKEN_PLAN_CN_API_KEY
unset BASETEN_API_KEY
unset COPILOT_GITHUB_TOKEN
unset GH_TOKEN
unset GITHUB_TOKEN
unset GOOGLE_APPLICATION_CREDENTIALS
unset GOOGLE_CLOUD_PROJECT
unset GCLOUD_PROJECT
unset GOOGLE_CLOUD_LOCATION
unset AWS_PROFILE
unset AWS_ACCESS_KEY_ID
unset AWS_SECRET_ACCESS_KEY
unset AWS_SESSION_TOKEN
unset AWS_REGION
unset AWS_DEFAULT_REGION
unset AWS_BEARER_TOKEN_BEDROCK
unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
unset AWS_CONTAINER_CREDENTIALS_FULL_URI
unset AWS_WEB_IDENTITY_TOKEN_FILE
unset BEDROCK_EXTENSIVE_MODEL_TEST

echo "Running tests without API keys..."
npm test
