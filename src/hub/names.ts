export const boxPrefix = "box-";

const nodeName = /^[a-z0-9][a-z0-9.-]*$/;
const boxName = /^box-[a-z0-9]+(-[a-z0-9]+)*$/;

export const isNodeName = (name: string) => nodeName.test(name);
export const isKeptForBoxes = (name: string) => name.startsWith(boxPrefix);
export const isBoxName = (name: string) => boxName.test(name);
export const canBeDevbox = (name: string) => isNodeName(name) && !isKeptForBoxes(name);

export function sshName(alias: string): string {
  if (!isNodeName(alias)) throw new Error(`${JSON.stringify(alias)} is not an SSH name Fleet can use.`);
  return alias;
}
