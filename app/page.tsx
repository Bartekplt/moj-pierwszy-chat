import { cookies } from "next/headers";
import { AUTH_CONFIGURATION_ERROR, isAuthConfigured, SESSION_COOKIE, verifySession } from "../lib/server/session.ts";
import Chat from "./chat";
import Login from "./login";

export default async function Home() {
  const cookieStore = await cookies();
  if (!isAuthConfigured()) return <Login configurationError={AUTH_CONFIGURATION_ERROR} />;
  if (!verifySession(cookieStore.get(SESSION_COOKIE)?.value)) return <Login />;
  return <Chat />;
}
