// Test-only: client.test.ts loads the real react runtime; the repo has no @types/react.
declare module "react";
declare module "react/jsx-runtime";
