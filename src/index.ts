// wrangler.toml harus mengaktifkan 'type = "module"'
// atau 'type = "javascript"' dengan 'compatibility_date' yang sesuai.

export default {
  async fetch(request: Request): Promise<Response> {
    // URL target yang akan diproxy
    const targetUrl = "https://ww3.anoboy.app/";
    
    // Buat permintaan baru ke URL target
    const proxyRequest = new Request(targetUrl, request);

    try {
      // Ambil respons dari URL target
      const response = await fetch(proxyRequest);

      // Buat respons baru dengan body dan status yang sama
      const newResponse = new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });

      // Tambahkan header caching untuk browser (misal: 1 jam)
      // Ini akan menghemat permintaan jika data tidak sering berubah.
      newResponse.headers.set("Cache-Control", "public, max-age=3600"); 

      return newResponse;

    } catch (error) {
      // Tangani kesalahan jaringan
      if (error instanceof Error) {
        return new Response(`Error: ${error.message}`, { status: 500 });
      }
      return new Response("An unexpected error occurred", { status: 500 });
    }
  },
};
