#!/bin/bash
# ─────────────────────────────────────────────────────────
# issue-to-cline.sh — Fetch a GitHub issue and dispatch to Cline
#
# Usage:
#   ./issue-to-cline.sh           # Lists open issues, picks interactively
#   ./issue-to-cline.sh 42        # Dispatches issue #42 directly
#   ./issue-to-cline.sh --list    # Just list open issues
# ─────────────────────────────────────────────────────────

REPO="jk212h20/BitcoinReview"
CWD="/Users/nick/ActiveProjects/BitcoinReview"

# Colors
BOLD='\033[1m'
DIM='\033[2m'
ORANGE='\033[38;5;208m'
GREEN='\033[32m'
CYAN='\033[36m'
RESET='\033[0m'

# ── List open issues ──
list_issues() {
  echo -e "${ORANGE}${BOLD}Open issues on ${REPO}${RESET}\n"
  gh issue list --repo "$REPO" --state open --json number,title,labels,createdAt \
    --jq '.[] | "  #\(.number)\t\(.labels | map(.name) | join(", "))\t\(.title)"' | \
    column -t -s $'\t'
  echo ""
}

# ── Just list? ──
if [ "$1" = "--list" ] || [ "$1" = "-l" ]; then
  list_issues
  exit 0
fi

# ── Pick issue number ──
if [ -n "$1" ]; then
  ISSUE_NUM="$1"
else
  list_issues
  echo -ne "${BOLD}Enter issue number to dispatch: ${RESET}"
  read ISSUE_NUM
  if [ -z "$ISSUE_NUM" ]; then
    echo "No issue selected. Exiting."
    exit 1
  fi
fi

# ── Fetch issue details ──
echo -e "\n${DIM}Fetching issue #${ISSUE_NUM}...${RESET}"
ISSUE_JSON=$(gh issue view "$ISSUE_NUM" --repo "$REPO" --json number,title,body,labels 2>&1)

if [ $? -ne 0 ]; then
  echo -e "Error: $ISSUE_JSON"
  exit 1
fi

TITLE=$(echo "$ISSUE_JSON" | jq -r '.title')
BODY=$(echo "$ISSUE_JSON" | jq -r '.body')
LABELS=$(echo "$ISSUE_JSON" | jq -r '.labels | map(.name) | join(", ")')

echo -e "\n${ORANGE}${BOLD}Issue #${ISSUE_NUM}: ${TITLE}${RESET}"
echo -e "${DIM}Labels: ${LABELS}${RESET}"
echo -e "${DIM}───────────────────────────────────${RESET}"
echo "$BODY" | head -20
if [ $(echo "$BODY" | wc -l) -gt 20 ]; then
  echo -e "${DIM}... (truncated)${RESET}"
fi
echo -e "${DIM}───────────────────────────────────${RESET}\n"

# ── Build Cline prompt ──
BRANCH_SLUG=$(echo "$TITLE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//' | cut -c1-40)
BRANCH="issue-${ISSUE_NUM}-${BRANCH_SLUG}"

PROMPT="A collaborator filed GitHub issue #${ISSUE_NUM} on the BitcoinReview project.

**Title:** ${TITLE}
**Labels:** ${LABELS}

**Issue Body:**
${BODY}

---

**Instructions:**
1. Read the memory bank (activeContext.md, progress.md) to understand the project
2. Understand what the issue is asking for
3. Implement the change — read relevant files first, then make edits
4. After completing the work, create a new git branch and commit:
   \`\`\`
   git checkout -b ${BRANCH}
   git add -A
   git commit -m \"Fix #${ISSUE_NUM}: ${TITLE}\"
   \`\`\`
5. Push the branch:
   \`\`\`
   git push origin ${BRANCH}
   \`\`\`
6. Create a PR:
   \`\`\`
   gh pr create --repo ${REPO} --base main --head ${BRANCH} --title \"Fix #${ISSUE_NUM}: ${TITLE}\" --body \"Resolves #${ISSUE_NUM}\n\n## Changes\n[describe what you changed]\"
   \`\`\`
7. Comment on the issue summarizing what you did:
   \`\`\`
   gh issue comment ${ISSUE_NUM} --repo ${REPO} --body \"I've implemented this in PR #<pr-number>. Here's what I changed: ...\"
   \`\`\`"

# ── Confirm ──
echo -e "${BOLD}Ready to dispatch to Cline.${RESET}"
echo -e "${DIM}Branch: ${BRANCH}${RESET}"
echo -ne "\n${BOLD}Dispatch? ${RESET}${DIM}(y/n)${RESET} "
read CONFIRM

if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
  echo "Cancelled."
  exit 0
fi

# ── Label as in-progress ──
gh issue edit "$ISSUE_NUM" --repo "$REPO" --add-label "cline-working" 2>/dev/null

# ── Copy prompt to clipboard for pasting into Cline ──
echo "$PROMPT" | pbcopy
echo -e "\n${GREEN}${BOLD}✓ Prompt copied to clipboard!${RESET}"
echo -e "${DIM}Paste it into Cline to start working on issue #${ISSUE_NUM}.${RESET}"
echo -e "\n${DIM}Or to use cline-dispatch MCP, the prompt is ready to go.${RESET}"
