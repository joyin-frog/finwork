import { SkillDetailPage } from "./skill-detail-page";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  return <SkillDetailPage name={name} />;
}
