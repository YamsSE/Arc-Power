# Arc Power orchestration workflow

Use this workflow for Arc Power tasks unless the user specifies otherwise.

- Planning and orchestration roles use DeepSeek V4.1 Flash with high reasoning:
  `lead`, `scoper`, `researcher`, and `specifier`.
- Implementation and fixing roles use DeepSeek V4.1 Flash with low reasoning:
  `developer`, `designer`, `debugger`, `evaluator`, and `evolver`.
- Review roles use DeepSeek V4 Pro with high reasoning: `reviewer`,
  `review_api`, `review_coordinator`, `review_quality`, `review_security`, and
  `review_tests`.
- The coordinating session delegates planning, implementation, fixes, and review to those roles when the available agent tools support them. If the current coordinating model cannot be changed, disclose that and use the delegated orchestration model for orchestration work.
- Assign nonoverlapping file ownership when agents work in parallel. Review changes and integrate findings before reporting completion.
- Follow the user's instructions and the repository's AGENTS.md, including hardware safety and Git workflow requirements.
