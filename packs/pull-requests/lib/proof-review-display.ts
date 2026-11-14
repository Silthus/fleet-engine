import { answeredFindings, type Answer, type reviewRecords } from "./proof.ts";

export type ReviewRecord = Awaited<ReturnType<typeof reviewRecords>>[number];
export type ReviewDisplay = Omit<ReviewRecord, "findings"> & {
  findings: { text: string; answer?: Answer }[];
  other?: string;
  counts: { findings: number; fixed: number; rejected: number; unknown: number };
};

export function reviewDisplay(records: ReviewRecord[]): ReviewDisplay[] {
  return records.map((record) => {
    const { findings, other } = answeredFindings(record.findings, record.responses ?? "");
    const count = (verdict: Answer["verdict"]) => findings.filter((finding) => finding.answer?.verdict === verdict).length;
    const [fixed, rejected] = [count("fixed"), count("rejected")];
    return {
      ...record, findings, ...other ? { other } : {},
      counts: { findings: findings.length, fixed, rejected, unknown: findings.length - fixed - rejected },
    };
  });
}
