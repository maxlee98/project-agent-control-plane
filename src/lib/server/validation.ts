export function validationEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  return { ...environment, NODE_ENV: "production" };
}