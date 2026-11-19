#define _GNU_SOURCE
#include <errno.h>
#include <inttypes.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

static int parse_id(const char *text, uintmax_t *id) {
    char *end;
    if (*text == '\0' || text[strspn(text, "0123456789")] != '\0')
        return 0;
    errno = 0;
    *id = strtoumax(text, &end, 10);
    return errno == 0 && *end == '\0' && *id < UINT32_MAX;
}

static int relay(int source, int target) {
    unsigned char buffer[16384];
    for (;;) {
        ssize_t received = read(source, buffer, sizeof(buffer));
        if (received == 0)
            return 1;
        if (received < 0) {
            if (errno == EINTR)
                continue;
            return 0;
        }
        ssize_t offset = 0;
        while (offset < received) {
            ssize_t written = write(target, buffer + offset, (size_t)(received - offset));
            if (written < 0 && errno == EINTR)
                continue;
            if (written <= 0)
                return 0;
            offset += written;
        }
    }
}

int main(int argc, char **argv) {
    struct sockaddr_un address = { .sun_family = AF_UNIX };
    uintmax_t uid, gid;
    if (argc != 4 || argv[1][0] != '/' ||
        !parse_id(argv[2], &uid) || !parse_id(argv[3], &gid))
        return EXIT_FAILURE;
    size_t length = strlen(argv[1]);
    if (length >= sizeof(address.sun_path))
        return EXIT_FAILURE;
    memcpy(address.sun_path, argv[1], length + 1);

    int socket_fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (socket_fd < 0 || connect(socket_fd, (struct sockaddr *)&address,
            (socklen_t)(offsetof(struct sockaddr_un, sun_path) + length + 1)) < 0)
        return EXIT_FAILURE;

    struct ucred peer;
    socklen_t peer_size = sizeof(peer);
    if (getsockopt(socket_fd, SOL_SOCKET, SO_PEERCRED, &peer, &peer_size) < 0 ||
        peer_size != sizeof(peer) || peer.uid != uid || peer.gid != gid)
        return EXIT_FAILURE;

    // The peer waits for request EOF before it produces a response.
    return relay(STDIN_FILENO, socket_fd) && shutdown(socket_fd, SHUT_WR) == 0 &&
        relay(socket_fd, STDOUT_FILENO) ? EXIT_SUCCESS : EXIT_FAILURE;
}
