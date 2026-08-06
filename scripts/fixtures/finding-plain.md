### app/api/profiles/route.js:10 — SQL injection

**Risk:** An attacker can manipulate the `email` URL parameter to execute arbitrary SQL commands, allowing them to extract secret data, bypass authentication, or modify the database.

**Fix:**
```javascript
export async function GET(request) {
  const url = new URL(request.url);
  const email = url.searchParams.get("email");

  if (!email) {
    return Response.json({ error: "Email parameter is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, full_name")
    .eq("email", email);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data);
}
```