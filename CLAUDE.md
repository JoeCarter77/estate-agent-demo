# Build Discipline

Work toward the current task's stated acceptance criterion using the minimum viable implementation.

When a task exposes a dependency:

1. Determine whether it actually blocks the current acceptance criterion.
2. If it does not block it, defer it and continue.
3. If it does block it, solve only the minimum required dependency.
4. Do not recursively refactor, redesign, optimise, or introduce infrastructure unless strictly required to unblock the current task.
5. Prefer a temporary/simple workaround over expanding scope when the workaround is safe and consistent with the current V1 architecture.
6. If solving a dependency creates another dependency, reassess whether that new dependency genuinely blocks the acceptance criterion before continuing.
7. Stop once the acceptance criterion passes. Do not continue improving the surrounding system.

Before making substantial changes, state:

- Current acceptance criterion
- Immediate blocker
- Minimum change required
- What will be explicitly deferred

Do not turn an implementation task into an architecture/refactoring exercise.
