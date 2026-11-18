# Agent Coordinator MCP

Một dashboard local để giao việc cho Codex và Antigravity, theo dõi tiến độ, trao đổi và xác nhận đã nhận lời nhắc. Hai app giữ nguyên giao diện chat; mỗi bên kết nối với MCP qua STDIO và cùng sử dụng một kho SQLite.

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

Trong **Kết nối MCP**, sao chép đoạn cấu hình tương ứng vào từng app và giữ nguyên các mục hiện có. Cả hai mục mới dùng tên `agent_coordinator_standalone`, với danh tính `codex` hoặc `antigravity` và cùng kho dữ liệu. Nạp lại cấu hình của app sau khi thêm. Khi agent bắt đầu làm việc, yêu cầu agent gọi `coordinator_inbox` và `coordinator_list_tasks`.

## Đánh thức chat đã chọn (tùy chọn trên Windows)

Dashboard và hai kết nối MCP có thể dùng độc lập với worker. Nếu muốn đánh thức chat, người dùng chủ động cài sidecar và bật từng chat UUID trên dashboard:

```powershell
.\install-wake.ps1 -CodexExecutable 'C:\path\to\codex.exe' -AntigravityExecutable 'C:\path\to\language_server.exe'
```

Dùng executable native của app. Installer tạo sidecar `agent-coordinator-standalone`, lưu đường dẫn bridge trong kho đã chọn và sao lưu tệp cấu hình cũ trước khi ghi. Nếu dùng `COORDINATOR_DATA_DIR` tùy chỉnh, truyền cùng đường dẫn cho launcher, installer và hai kết nối MCP. Để tắt worker, đặt `sidecars.agent-coordinator-standalone.enabled=false` trong cấu hình Antigravity rồi tải lại app. Cài đặt bản tách không thay sidecar cũ.

Máy và app phải đang chạy, chat phải được chọn và bật. Worker chuyển lời nhắc qua CLI của host. Trạng thái **Đã chuyển** chỉ nói bridge nhận được lệnh; **Chat đã nhận qua MCP** xuất hiện sau khi đúng agent gọi `coordinator_ack_wake`. Đó là biên nhận riêng với đọc tin và tiến độ công việc. Timeout hay kết quả không rõ cần kiểm lại chat trước khi gửi lại. Tùy chọn `codex.resume` không bật mặc định; bản phát hành này chưa nghiệm thu resume qua managed daemon.

## Kiến trúc và kiểm thử

- `server.mjs`: dashboard HTTP trên loopback, kiểm Host, Origin và token phiên khi ghi.
- `store.mjs`: giao dịch SQLite, revision để phát hiện sửa đồng thời, request ID để thử lại không nhân đôi, ACK theo danh tính và hàng đợi wake.
- `mcp.mjs`: 8 công cụ STDIO, danh tính gắn với tiến trình. `wake-worker.mjs`: claim, phân lô và ghi kết quả chuyển lời nhắc; không chạy lệnh nhận từ tin nhắn.
- `demo.mjs`: kịch bản với SQLite tạm, bridge giả lập và hai client MCP thật. Cổng tự chọn, độc lập với dashboard thường.

Chạy `npm test`. Bộ test kiểm quyền đọc/ghi, xung đột revision, gửi lại, rollback, claim đồng thời, biên nhận của hai client và luồng demo. Bản import lấy mã đã theo dõi tại [`0caa3832`](https://github.com/whaticando0110/Reverend-insanity-discord-game/tree/0caa3832/apps/agent-coordinator). [PR gốc #8](https://github.com/whaticando0110/Reverend-insanity-discord-game/pull/8) ghi nghiệm thu chat thật của bản gốc; bản độc lập chưa đổi các kết nối đó.
