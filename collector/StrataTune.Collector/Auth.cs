using System.Net;
using System.Security.Cryptography;
using System.Text;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>Every request carries the per-launch token from the handshake file (plan
/// section 5, risk R8). Kestrel only listens on loopback; the remote-address check is the
/// belt to that pair of braces. The token alone is not proof of identity, though: it sits in
/// a file any same-user process can read (see PeerProcess.cs), so once the bytes match, the
/// peer itself is checked against <see cref="PeerTrust"/> before the request is let through.</summary>
internal static class Auth
{
    private const string Scheme = "Bearer ";

    public static IApplicationBuilder UseBearerToken(this IApplicationBuilder app, string token, PeerTrust trust, Action<string> log)
    {
        var expected = Encoding.ASCII.GetBytes(token);
        return app.Use(async (context, next) =>
        {
            var remote = context.Connection.RemoteIpAddress;
            if (remote is null || !IPAddress.IsLoopback(remote))
            {
                await Reject(context, StatusCodes.Status403Forbidden, "loopback only");
                return;
            }

            var header = context.Request.Headers.Authorization.ToString();
            var presented = header.StartsWith(Scheme, StringComparison.Ordinal)
                ? Encoding.ASCII.GetBytes(header[Scheme.Length..].Trim())
                : [];
            if (!CryptographicOperations.FixedTimeEquals(presented, expected))
            {
                context.Response.Headers.WWWAuthenticate = "Bearer";
                await Reject(context, StatusCodes.Status401Unauthorized, "missing or wrong token");
                return;
            }

            // Threat: same-user malware that merely read the token file off disk. --serve's
            // development escape hatch aside, a request that reaches here still has to be
            // made by a process PeerProcess.IsTrusted actually recognizes.
            if (!trust.TrustLocalPeers)
            {
                var peer = PeerProcess.Resolve(context.Connection.RemotePort);
                var trusted = peer is { } p && PeerProcess.IsTrusted(p.Pid, p.ImagePath, trust);
                if (!trusted)
                {
                    var pidText = peer?.Pid.ToString() ?? "?";
                    var imageText = peer?.ImagePath is { } path ? Path.GetFileName(path) : "?";
                    log($"auth: refused peer pid {pidText} image {imageText}");
                    await Reject(context, StatusCodes.Status403Forbidden, "untrusted peer process");
                    return;
                }
            }

            await next(context);
        });
    }

    private static Task Reject(HttpContext context, int status, string error)
    {
        context.Response.StatusCode = status;
        return context.Response.WriteAsJsonAsync(new ApiError(error), WireJson.Default.ApiError);
    }
}
