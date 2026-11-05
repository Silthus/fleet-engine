export const aliasPattern = /^[a-z0-9][a-z0-9.-]*$/;
export const boxPattern = /^box-[a-z0-9][a-z0-9-]*$/;
export const isBoxName = (name: string) => boxPattern.test(name);

export function sshName(alias: string): string {
  if (!aliasPattern.test(alias)) throw new Error(`${JSON.stringify(alias)} is not an SSH name Fleet can use.`);
  return alias;
}
