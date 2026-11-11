export const boxPrefix = "box-";

const nodeName = /^[a-z0-9][a-z0-9.-]*$/;

export const isNodeName = (name: string) => nodeName.test(name);
export const isBoxName = (name: string) => isNodeName(name) && name.startsWith(boxPrefix) && name.length > boxPrefix.length;
export const isKeptForBoxes = (name: string) => name.startsWith(boxPrefix);

export function sshName(alias: string): string {
  if (!isNodeName(alias)) throw new Error(`${JSON.stringify(alias)} is not an SSH name Fleet can use.`);
  return alias;
}
