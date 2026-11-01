"use client";

import { useState, type FormEvent } from "react";

export default function Login({ configurationError = "" }: { configurationError?: string }) {
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !password.trim() || configurationError) return;
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      setPassword("");
      if (!response.ok) {
        setError(await response.text());
        setPending(false);
        return;
      }
      window.location.replace("/");
    } catch {
      setPassword("");
      setError("Nie udało się połączyć. Spróbuj ponownie.");
      setPending(false);
    }
  }

  return (
    <main className="login">
      <h1>Wpisz hasło</h1>
      <form onSubmit={login}>
        <label htmlFor="password">Hasło warsztatowe</label>
        <div className="composer">
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            maxLength={1024}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={pending || !!configurationError}
            required
          />
          <button type="submit" disabled={pending || !password.trim() || !!configurationError}>
            {pending ? "Sprawdzam…" : "Wejdź"}
          </button>
        </div>
      </form>
      {(configurationError || error) && <p className="error" role="alert">{configurationError || error}</p>}
    </main>
  );
}
