/^#/ { if (h != "") printf "%d\t%s\n", n, h; h=$0; n=0; next }
{ n += NF }
END { if (h != "") printf "%d\t%s\n", n, h }
