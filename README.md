# Agent Coordinator MCP

Một dashboard local để giao việc, theo dõi tiến độ, trao đổi và xác nhận đã nhận lời nhắc. Codex, Antigravity và các app hỗ trợ MCP STDIO có thể kết nối bằng hồ sơ riêng trên cùng một kho SQLite.

## Xem thử trong một phút

Cần Node.js 24 trở lên. Từ thư mục repo, chạy:

```sh
npm ci --ignore-scripts
npm run demo
```

Mở URL `127.0.0.1` in ở terminal. Bấm lần lượt năm bước: giao việc → chuyển lời nhắc Codex → Codex xác nhận và nhờ review → chuyển lời nhắc Antigravity → Antigravity xác nhận và phản hồi. Tab **Kết nối MCP** phân biệt thời điểm worker đã chuyển với thời điểm từng client đã ACK; tab **Hộp thư chung** hiển thị phản hồi.

Demo dùng hành vi agent theo kịch bản và mô phỏng bridge gửi lời nhắc. Hai client STDIO gọi công cụ MCP thật, biên nhận lưu trong SQLite tạm. Không cần cài Codex/Antigravity, không đọc cấu hình cá nhân, không gửi lời nhắc tới chat thật. Dừng bằng Ctrl+C để dọn kho tạm; chạy lại để bắt đầu kịch bản mới.

![Hai biên nhận trong dashboard demo](docs/demo-dashboard.png)

## Chạy dashboard để sử dụng thật

```sh
npm ci --ignore-scripts
npm run serve
```

Mở `http://127.0.0.1:4330`. Trên Windows cũng có thể bấm đúp `Open Coordinator.cmd`; launcher sẽ cài dependency nếu cần. Dữ liệu mặc định nằm tại `%LOCALAPPDATA%/AgentCoordinatorMCP` hoặc `~/AgentCoordinatorMCP` nếu không có `LOCALAPPDATA`. `COORDINATOR_DATA_DIR` nhận đường dẫn tuyệt đối tới kho khác; `COORDINATOR_PORT` đổi cổng. Bản này không tự nối, nhập hay sửa dữ liệu điều phối của repo game.

Trong **Kết nối MCP → Hồ sơ app và model**, chọn hồ sơ có sẵn hoặc thêm hồ sơ với mã riêng. Có mẫu cho Codex, Antigravity, [Claude Desktop](https://py.sdk.modelcontextprotocol.io/get-started/real-host/), [Cursor](https://docs.cursor.com/context/model-context-protocol), [VS Code](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) và [Gemini CLI](https://geminicli.com/docs/tools/mcp-server/). Chọn **App MCP STDIO khác** nếu muốn dùng app tương thích khác. Nếu app không dùng cấu trúc JSON mẫu, dùng cùng giá trị `command` và `args` theo tài liệu của app.

Model do app chủ chọn và chạy. Tên model trong hồ sơ để theo dõi; app điều phối không đổi model từ xa hay yêu cầu API key. Các hồ sơ ngoài hai bridge tích hợp nhận việc khi gọi MCP; chưa có đánh thức native cho chúng.

Sao chép riêng mục được tạo vào cấu hình app, nạp lại kết nối, rồi gọi `coordinator_list_tasks` trong chat thử. Nút **Kiểm tra lần gọi** cho biết hồ sơ nào đã thực sự gọi công cụ. Để quay lui, bỏ riêng mục được hiển thị trong hướng dẫn và tắt đánh thức nếu đã bật; giữ nguyên các cấu hình khác. Các mẫu cấu hình app mới đã được đối chiếu tài liệu và phần STDIO đã thử bằng một client thứ ba, chưa chạy nghiệm thu trong từng app desktop.

`npm run doctor` kiểm tra cổng, checkout/kho đang phục vụ, thư viện và tình trạng bridge mà không tạo SQLite hay chỉnh cấu hình. Dùng `npm --silent run doctor -- --json` nếu cần kết quả để xử lý bằng máy. Nếu trên cổng đã có dashboard của kho khác, launcher Windows báo lỗi và không tự mở nhầm kho. Dừng đúng tiến trình hoặc chọn `COORDINATOR_PORT` khác.

Tab **Kết nối MCP** cho biết lần gọi công cụ cuối, bridge có tìm được tệp chạy hay không, chat đích đã bật chưa, số việc chờ chuyển và số lời nhắc cần kiểm tra thủ công. “Lần gọi cuối” không chứng minh agent đang online; tìm được tệp bridge không chứng minh app sẽ chấp nhận lời nhắc. **Tải chẩn đoán** xuất báo cáo với trạng thái và số đếm; không chứa thư mục cá nhân, chat UUID, tên/model hồ sơ tùy chỉnh, nội dung tin hoặc token.

## Đánh thức chat đã chọn (tùy chọn trên Windows)

Dashboard và hai kết nối MCP có thể dùng độc lập với worker. Nếu muốn đánh thức chat, người dùng chủ động cài sidecar và bật từng chat UUID trên dashboard:

```powershell
.\install-wake.ps1 -CodexExecutable 'C:\path\to\codex.exe' -AntigravityExecutable 'C:\path\to\language_server.exe'
```

Dùng executable native của app. Installer tạo sidecar `agent-coordinator-standalone`, lưu đường dẫn bridge trong kho đã chọn và sao lưu tệp cấu hình cũ trước khi ghi. Nếu dùng `COORDINATOR_DATA_DIR` tùy chỉnh, truyền cùng đường dẫn cho launcher, installer và hai kết nối MCP. Để tắt worker, đặt `sidecars.agent-coordinator-standalone.enabled=false` trong cấu hình Antigravity rồi tải lại app. Cài đặt bản tách không thay sidecar cũ.

Máy và app phải đang chạy, chat phải được chọn và bật. Worker chuyển lời nhắc qua CLI của host. Trạng thái **Đã chuyển** chỉ nói bridge nhận được lệnh; **Chat đã nhận qua MCP** xuất hiện sau khi đúng agent gọi `coordinator_ack_wake`. Đó là biên nhận riêng với đọc tin và tiến độ công việc. Timeout hay kết quả không rõ cần kiểm lại chat trước khi gửi lại. Tùy chọn `codex.resume` không bật mặc định; bản phát hành này chưa nghiệm thu resume qua managed daemon.

Nếu bridge bị thiếu hoặc cấu hình lỗi, worker giữ nguyên yêu cầu đang chờ và vẫn xử lý bên còn lại nếu đủ cấu hình. Khi sửa đúng bridge, các yêu cầu còn chờ có thể được gửi; trước khi sửa, tắt chat đích nếu muốn hủy hàng đợi cũ. Lưu lại cùng chat và cùng trạng thái sẽ giữ hàng đợi; đổi chat hoặc tắt sẽ hủy yêu cầu chưa gửi. Những lượt đã nhận nhưng chưa rõ kết quả không được gửi lại tự động.

Lần đầu dùng thật, hãy thêm mục MCP mới và cho mỗi bên gọi `coordinator_list_tasks` để thấy dấu truy cập đúng dashboard. Sau đó chọn chat thử riêng, bật đánh thức và giao một việc mẫu cho từng bên. Đối chiếu **Đã chuyển → Chat đã nhận qua MCP → đã đọc tin** trước khi dùng cho chat công việc. Các bước này không cần đổi cấu hình hay kho của bản gốc.

Tab **Lời nhắc** lọc và phân trang theo agent/trạng thái, hiển thị giờ chuyển/ACK, việc chờ trên hai phút và liên kết tới công việc hoặc tin tạo yêu cầu. Chỉ lời nhắc chưa chuyển mới hủy được. Với lời nhắc lỗi hoặc chưa rõ kết quả, kiểm tra chat trước khi dùng **Đã kiểm chat · Gửi lại**. Gửi lại tạo mục mới có tham chiếu cũ; ACK đến muộn sẽ hủy lượt gửi lại còn chờ.

## Sao lưu và phục hồi

```sh
npm run backup -- "coordinator-backup.sqlite"
npm run restore -- "coordinator-backup.sqlite" "coordinator-restore"
```

Có thể sao lưu khi dashboard và MCP vẫn dùng kho nguồn. App dùng SQLite Online Backup API để tạo ảnh nhất quán và kiểm tính toàn vẹn trước khi hoàn tất. Tệp đích chưa được tồn tại. Kho phục hồi phải là thư mục mới; lần đầu mở nó, đặt `COORDINATOR_DATA_DIR` thành đường dẫn tuyệt đối tới đó và, nếu vẫn chạy kho nguồn, đặt `COORDINATOR_PORT` khác.

Phục hồi giữ nhiệm vụ, tin, hồ sơ, lịch sử và biên nhận; tắt toàn bộ chat đích và hủy lời nhắc chưa chuyển trong bản phục hồi. Lượt đang chuyển được ghi là chưa rõ kết quả. Không phục hồi cấu hình bridge hoặc đường dẫn đến app. Tệp SQLite chứa nội dung làm việc: giữ ngoài Git.

Bản P1 tự nâng schema cũ từ v1 lên v2 khi mở kho. Nếu cần khả năng quay về mã trước P1, giữ bản sao v1 trước khi mở kho bằng bản này; bản cũ không mở được schema v2.

## Kiến trúc và kiểm thử

- `server.mjs`: dashboard HTTP trên loopback, kiểm Host, Origin và token phiên khi ghi.
- `store.mjs`: giao dịch SQLite, revision để phát hiện sửa đồng thời, request ID để thử lại không nhân đôi, ACK theo danh tính và hàng đợi wake.
- `mcp.mjs`: 8 công cụ STDIO, danh tính gắn với tiến trình. `wake-worker.mjs`: claim, phân lô và ghi kết quả chuyển lời nhắc; không chạy lệnh nhận từ tin nhắn.
- `demo.mjs`: kịch bản với SQLite tạm, bridge giả lập và hai client MCP thật. Cổng tự chọn, độc lập với dashboard thường.

Chạy `npm test`. Bộ test kiểm quyền đọc/ghi, xung đột revision, gửi lại, rollback, claim đồng thời, biên nhận của hai client và luồng demo. Bản import lấy mã đã theo dõi tại [`0caa3832`](https://github.com/whaticando0110/Reverend-insanity-discord-game/tree/0caa3832/apps/agent-coordinator). [PR gốc #8](https://github.com/whaticando0110/Reverend-insanity-discord-game/pull/8) ghi nghiệm thu chat thật của bản gốc; bản độc lập chưa đổi các kết nối đó.
