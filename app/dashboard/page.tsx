import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "../../lib/server/session.ts";
import { travelToday } from "../../lib/server/travel-dashboard.ts";
import TravelDashboard from "./travel-dashboard";

export const metadata = { title: "Asystent podróży | Mój chatbot" };

export default async function DashboardPage() {
  const cookieStore = await cookies();
  if (!verifySession(cookieStore.get(SESSION_COOKIE)?.value)) redirect("/");
  return <TravelDashboard today={travelToday()} />;
}
