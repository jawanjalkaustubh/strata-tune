using System.Net;
using System.Security.Cryptography;
using System.Text;
using StrataTune.Shared;

namespace StrataTune.Collector;

/// <summary>Every request carries the per-launch token from the handshake file (plan
/// section 5, risk R8). Kestrel only listens on loopback; the remote-address check is the
/// belt to that pair of braces.</summary>
internal static class Auth
{
    private const string Scheme = "Bearer ";

    public static IApplicationBuilder UseBearerToken(this IApplicationBuilder app, string token)
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

            await next(context);
        });
    }

    private static Task Reject(HttpContext context, int status, string error)
    {
        context.Response.StatusCode = status;
        return context.Response.WriteAsJsonAsync(new ApiError(error), WireJson.Default.ApiError);
    }
}
