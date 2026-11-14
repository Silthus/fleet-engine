import { answerItem, reviewedFindings, type reviewRecords } from "./proof.ts";

export type ReviewRecord = Awaited<ReturnType<typeof reviewRecords>>[number];
export type Answer = { verdict: "fixed" | "rejected"; text: string };
export type ReviewDisplay = Omit<ReviewRecord, "findings"> & {
  findings: { text: string; answer?: Answer }[];
  other?: string;
  counts: { findings: number; fixed: number; rejected: number; unknown: number };
};

function answersOf(responses: string) {
  const answers = new Map<number, Answer>();
  const other: string[] = [];
  for (const line of responses.split("\n")) {
    const match = answerItem.exec(line);
    if (match && !answers.has(Number(match[1]))) answers.set(Number(match[1]), { verdict: match[2]!.toLowerCase() as Answer["verdict"], text: line.trim() });
    else if (line.trim()) other.push(line.trim());
  }
  return { answers, other: other.join("\n") };
}

export function reviewDisplay(records: ReviewRecord[]): ReviewDisplay[] {
  return records.map((record) => {
    const { answers, other } = answersOf(record.responses ?? "");
    const findings = reviewedFindings(record.findings).map((text, index) => ({ text, ...answers.has(index + 1) ? { answer: answers.get(index + 1) } : {} }));
    const count = (verdict: Answer["verdict"]) => findings.filter((finding) => finding.answer?.verdict === verdict).length;
    const [fixed, rejected] = [count("fixed"), count("rejected")];
    return {
      ...record, findings, ...other ? { other } : {},
      counts: { findings: findings.length, fixed, rejected, unknown: findings.length - fixed - rejected },
    };
  });
}
